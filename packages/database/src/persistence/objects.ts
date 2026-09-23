import { isIP } from "node:net";
import {
  databaseBytes,
  inPersistenceTransaction,
  OperationConflictError,
  OperationNotCancellableError,
  OperationNotFoundError,
  type PersistenceClient,
  requireActiveDevice,
  StagedObjectConflictError,
  sameBytes,
} from "./repository-core";
import { inShortTransaction, type TransactionDatabase } from "./transaction";
import {
  copyBytes,
  validateDigest,
  validateProtocolProjection,
  validateSha384Digest,
  validateStagedObject,
} from "./validation";
export type ProtocolObjectInput = Readonly<{
  readonly id: string;
  readonly suite: string;
  readonly formatVersion: number;
  readonly kind: number;
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
  readonly projectId?: string;
  readonly environmentId?: string;
}>;

export class ProtocolObjectRepository {
  async create(database: PersistenceClient, input: ProtocolObjectInput) {
    validateProtocolProjection(input);
    const canonicalBytes = copyBytes(
      input.canonicalBytes,
      "canonical protocol bytes",
    );
    const digest = await validateSha384Digest(canonicalBytes, input.digest);
    return database.protocolObject.create({
      data: {
        id: input.id,
        suite: input.suite,
        formatVersion: input.formatVersion,
        kind: input.kind,
        canonicalBytes: databaseBytes(canonicalBytes),
        digest: databaseBytes(digest),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      },
    });
  }

  async findByDigest(database: PersistenceClient, digest: Uint8Array) {
    return database.protocolObject.findUnique({
      where: { digest: databaseBytes(validateDigest(digest)) },
    });
  }
}

export type StageObjectInput = Readonly<{
  readonly operationId: string;
  readonly objectId: string;
  readonly actorDeviceId: string;
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}>;

export class StagedObjectRepository {
  async put(database: PersistenceClient, input: StageObjectInput) {
    validateStagedObject(input);
    const canonicalBytes = copyBytes(
      input.canonicalBytes,
      "staged canonical bytes",
    );
    const requestedDigest = await validateSha384Digest(
      canonicalBytes,
      input.digest,
    );
    return inPersistenceTransaction(database, async (transaction) => {
      await transaction.stagedObject.createMany({
        data: [
          {
            operationId: input.operationId,
            objectId: input.objectId,
            actorDeviceId: input.actorDeviceId,
            canonicalBytes: databaseBytes(canonicalBytes),
            digest: databaseBytes(requestedDigest),
            createdAt: input.createdAt,
            expiresAt: input.expiresAt,
          },
        ],
        skipDuplicates: true,
      });
      const staged = await transaction.stagedObject.findUnique({
        where: {
          operationId_objectId: {
            operationId: input.operationId,
            objectId: input.objectId,
          },
        },
      });
      if (
        !staged ||
        staged.actorDeviceId !== input.actorDeviceId ||
        !sameBytes(staged.digest, requestedDigest) ||
        !sameBytes(staged.canonicalBytes, canonicalBytes)
      )
        throw new StagedObjectConflictError();
      return staged;
    });
  }

  async expire(database: PersistenceClient, now: Date) {
    return database.stagedObject.deleteMany({
      where: { expiresAt: { lte: now }, committedAt: null },
    });
  }

  async promote(
    database: PersistenceClient,
    input: Readonly<{
      readonly operationId: string;
      readonly actorDeviceId: string;
      readonly now: Date;
      readonly objects: ReadonlyArray<{
        readonly objectId: string;
        readonly canonicalBytes: Uint8Array;
        readonly digest: Uint8Array;
      }>;
    }>,
  ) {
    for (const object of input.objects) {
      const staged = await database.stagedObject.findUnique({
        where: {
          operationId_objectId: {
            operationId: input.operationId,
            objectId: object.objectId,
          },
        },
      });
      if (
        !staged ||
        staged.actorDeviceId !== input.actorDeviceId ||
        staged.committedAt !== null ||
        staged.expiresAt <= input.now ||
        !sameBytes(staged.canonicalBytes, object.canonicalBytes) ||
        !sameBytes(staged.digest, object.digest)
      )
        throw new Error("protocol object was not staged by the actor");
      await database.stagedObject.update({
        where: {
          operationId_objectId: {
            operationId: input.operationId,
            objectId: object.objectId,
          },
        },
        data: { committedAt: input.now },
      });
    }
  }
}

export type OperationInput = Readonly<{
  readonly id: string;
  readonly actorUserId: string;
  readonly actorDeviceId?: string;
  readonly kind:
    | "ADMINISTRATION"
    | "INVITATION"
    | "MEMBERSHIP_CHANGE"
    | "DEVICE_ENROLLMENT"
    | "DEVICE_REVOCATION"
    | "ACCOUNT_KEY"
    | "ENVIRONMENT_GENESIS"
    | "REVISION_PUBLICATION"
    | "ROLLBACK"
    | "EPOCH_ROTATION";
  readonly commandBytes: Uint8Array;
  readonly commandDigest: Uint8Array;
  readonly expiresAt?: Date;
}>;

export class OperationRepository {
  async begin(database: PersistenceClient, input: OperationInput) {
    const digest = databaseBytes(
      await validateSha384Digest(
        input.commandBytes,
        input.commandDigest,
        "operation digest",
      ),
    );
    return inPersistenceTransaction(database, async (transaction) => {
      await transaction.operation.createMany({
        data: [
          {
            id: input.id,
            actorUserId: input.actorUserId,
            ...(input.actorDeviceId
              ? { actorDeviceId: input.actorDeviceId }
              : {}),
            kind: input.kind,
            commandDigest: digest,
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          },
        ],
        skipDuplicates: true,
      });
      const operation = await transaction.operation.findUnique({
        where: { id: input.id },
      });
      if (
        !operation ||
        operation.actorUserId !== input.actorUserId ||
        operation.actorDeviceId !== (input.actorDeviceId ?? null) ||
        operation.kind !== input.kind ||
        !sameBytes(operation.commandDigest, digest) ||
        operation.status === "CANCELLED" ||
        operation.status === "EXPIRED"
      )
        throw new OperationConflictError();
      return {
        operation,
        idempotent: operation.status === "COMMITTED",
      };
    });
  }

  async expireStaging(database: TransactionDatabase, now: Date) {
    return inShortTransaction(database, async (transaction) => {
      const expired = await transaction.operation.findMany({
        where: { status: "STAGED", expiresAt: { lte: now } },
        select: { id: true, actorUserId: true, actorDeviceId: true },
      });
      if (expired.length === 0) return 0;
      let expiredCount = 0;
      for (const operation of expired) {
        const result = await transaction.operation.updateMany({
          where: { id: operation.id, status: "STAGED" },
          data: { status: "EXPIRED" },
        });
        if (result.count !== 1) continue;
        await transaction.stagedObject.deleteMany({
          where: { operationId: operation.id, committedAt: null },
        });
        await transaction.auditEvent.create({
          data: {
            operationId: operation.id,
            kind: "OPERATION_EXPIRED",
            actorUserId: operation.actorUserId,
            ...(operation.actorDeviceId
              ? { actorDeviceId: operation.actorDeviceId }
              : {}),
            entityKind: "OPERATION",
            entityId: operation.id,
          },
        });
        expiredCount += 1;
      }
      return expiredCount;
    });
  }

  async cancel(
    database: PersistenceClient,
    input: Readonly<{
      readonly operationId: string;
      readonly actorUserId: string;
      readonly actorDeviceId: string;
    }>,
  ) {
    return inPersistenceTransaction(database, async (transaction) => {
      await requireActiveDevice(
        transaction,
        input.actorUserId,
        input.actorDeviceId,
      );
      const operation = await transaction.operation.findUnique({
        where: { id: input.operationId },
      });
      if (
        !operation ||
        operation.actorUserId !== input.actorUserId ||
        operation.actorDeviceId !== input.actorDeviceId
      )
        throw new OperationNotFoundError();
      if (operation.status === "CANCELLED")
        return Object.freeze({ operation, idempotent: true });
      if (operation.status !== "STAGED")
        throw new OperationNotCancellableError();
      await transaction.stagedObject.deleteMany({
        where: { operationId: operation.id, committedAt: null },
      });
      const result = await transaction.operation.updateMany({
        where: { id: operation.id, status: "STAGED" },
        data: { status: "CANCELLED" },
      });
      if (result.count !== 1) {
        const current = await transaction.operation.findUnique({
          where: { id: operation.id },
        });
        if (current?.status === "CANCELLED")
          return Object.freeze({ operation: current, idempotent: true });
        throw new OperationNotCancellableError();
      }
      const cancelled = await transaction.operation.findUnique({
        where: { id: operation.id },
      });
      if (!cancelled) throw new OperationNotFoundError();
      await transaction.auditEvent.create({
        data: {
          operationId: cancelled.id,
          kind: "OPERATION_CANCELLED",
          actorUserId: input.actorUserId,
          actorDeviceId: input.actorDeviceId,
          entityKind: "OPERATION",
          entityId: cancelled.id,
        },
      });
      return Object.freeze({ operation: cancelled, idempotent: false });
    });
  }
}

export type AuditFactInput = Readonly<{
  readonly operationId: string;
  readonly kind:
    | "TEAM_CREATED"
    | "MEMBERSHIP_INVITED"
    | "MEMBERSHIP_ACCEPTED"
    | "MEMBERSHIP_ACTIVATED"
    | "MEMBERSHIP_ROLE_CHANGED"
    | "MEMBERSHIP_REMOVED"
    | "DEVICE_ENROLLED"
    | "DEVICE_REVOKED"
    | "ACCOUNT_KEY_WRAPPER_ADDED"
    | "ACCOUNT_KEY_WRAPPER_REVOKED"
    | "ACCOUNT_KEY_ENVELOPE_PUBLISHED"
    | "ACCOUNT_KEY_TRANSFER_CREATED"
    | "PROJECT_CREATED"
    | "PROJECT_ARCHIVED"
    | "PROJECT_RESTORED"
    | "ENVIRONMENT_CREATED"
    | "ENVIRONMENT_ARCHIVED"
    | "ENVIRONMENT_RESTORED"
    | "REVISION_PUBLISHED"
    | "ROLLBACK_PUBLISHED"
    | "EPOCH_ROTATED"
    | "GRANT_CREATED"
    | "DEVICE_ENROLLMENT_STARTED"
    | "DEVICE_ENROLLMENT_APPROVED"
    | "OPERATION_CANCELLED"
    | "OPERATION_EXPIRED";
  readonly actorUserId?: string;
  readonly actorDeviceId?: string;
  readonly entityKind:
    | "SERVER_PROFILE"
    | "USER"
    | "DEVICE"
    | "TEAM"
    | "MEMBERSHIP"
    | "INVITATION"
    | "PROJECT"
    | "ENVIRONMENT"
    | "OPERATION"
    | "PROTOCOL_OBJECT"
    | "REVISION"
    | "ACCOUNT_KEY_WRAPPER"
    | "ACCOUNT_KEY_ENVELOPE"
    | "ACCOUNT_KEY_TRANSFER";
  readonly entityId: string;
  readonly priorLifecycle?: string;
  readonly newLifecycle?: string;
  readonly outcomeObjectId?: string;
  readonly outcomeRevisionId?: string;
}>;

export class AuditFactRepository {
  async append(database: PersistenceClient, input: AuditFactInput) {
    return database.auditEvent.create({
      data: {
        operationId: input.operationId,
        kind: input.kind,
        entityKind: input.entityKind,
        entityId: input.entityId,
        ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
        ...(input.actorDeviceId ? { actorDeviceId: input.actorDeviceId } : {}),
        ...(input.priorLifecycle
          ? { priorLifecycle: input.priorLifecycle }
          : {}),
        ...(input.newLifecycle ? { newLifecycle: input.newLifecycle } : {}),
        ...(input.outcomeObjectId
          ? { outcomeObjectId: input.outcomeObjectId }
          : {}),
        ...(input.outcomeRevisionId
          ? { outcomeRevisionId: input.outcomeRevisionId }
          : {}),
      },
    });
  }
}

export class SecurityRequestLogRepository {
  async append(
    database: PersistenceClient,
    input: Readonly<{
      readonly ipAddress: string;
      readonly endpointTemplate: SecurityRequestEndpointTemplate;
      readonly httpStatus: number;
      readonly transferBytes: bigint;
      readonly requestedAt: Date;
      readonly expiresAt: Date;
    }>,
  ) {
    if (!SECURITY_REQUEST_ENDPOINT_TEMPLATES.includes(input.endpointTemplate))
      throw new Error(
        "Security Request Log endpoint template is not allowlisted",
      );
    if (isIP(input.ipAddress) === 0)
      throw new Error("Security Request Log IP address is invalid");
    if (
      !Number.isInteger(input.httpStatus) ||
      input.httpStatus < 100 ||
      input.httpStatus > 599
    )
      throw new Error("Security Request Log status is invalid");
    if (input.transferBytes < 0n)
      throw new Error("Security Request Log transfer size is invalid");
    if (
      Number.isNaN(input.requestedAt.getTime()) ||
      Number.isNaN(input.expiresAt.getTime())
    )
      throw new Error("Security Request Log timestamp is invalid");
    if (input.expiresAt <= input.requestedAt)
      throw new Error("Security Request Log must expire after receipt");
    if (
      input.expiresAt.getTime() - input.requestedAt.getTime() >
      SECURITY_REQUEST_LOG_RETENTION_MS
    )
      throw new Error("Security Request Log retention exceeds 30 days");
    return database.$executeRaw`
      INSERT INTO "security_request_logs"
        ("id", "ipAddress", "endpointTemplate", "httpStatus", "transferBytes", "requestedAt", "expiresAt")
      VALUES
        (${crypto.randomUUID()}, CAST(${input.ipAddress} AS INET), ${input.endpointTemplate}, ${input.httpStatus}, ${input.transferBytes}, ${input.requestedAt}, ${input.expiresAt})
    `;
  }

  async expire(database: TransactionDatabase, now: Date) {
    return inShortTransaction(database, (transaction) =>
      transaction.securityRequestLog.deleteMany({
        where: { expiresAt: { lte: now } },
      }),
    );
  }
}

export const SECURITY_REQUEST_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const SECURITY_REQUEST_ENDPOINT_TEMPLATES = Object.freeze([
  "/health",
  "/api/v1/capabilities",
  "/api/v1/session",
  "/device",
  "/api/auth/*",
  "/api/v1/operations/:operationId/begin",
  "/api/v1/operations/:operationId/staging/:objectId",
  "/api/v1/operations/:operationId/finalize",
  "/api/v1/operations/:operationId",
  "/api/v1/environments/:environmentId/sync",
  "/api/v1/operations/:operationId/epoch-transitions",
] as const);

export type SecurityRequestEndpointTemplate =
  (typeof SECURITY_REQUEST_ENDPOINT_TEMPLATES)[number];
