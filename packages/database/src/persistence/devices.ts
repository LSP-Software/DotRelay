import {
  AuditFactRepository,
  type OperationInput,
  OperationRepository,
  type ProtocolObjectInput,
  ProtocolObjectRepository,
  StagedObjectRepository,
} from "./objects";
import { databaseBytes, requireActiveDevice } from "./repository-core";
import { inShortTransaction, type TransactionDatabase } from "./transaction";
import {
  validateDigest,
  validatePublicKeys,
  validateSha384Digest,
} from "./validation";
export type DeviceEnrollmentBeginInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly enrollmentId: string;
  readonly userId: string;
  readonly initiatorDeviceId: string;
  readonly transcriptHash: Uint8Array;
  readonly challengeHash: Uint8Array;
  readonly expiresAt: Date;
  readonly now?: Date;
}>;

export type DeviceEnrollmentApprovalInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly enrollmentId: string;
  readonly approvalObject: ProtocolObjectInput;
  readonly now?: Date;
}>;

export type DeviceBootstrapInput = Readonly<{
  readonly operation: OperationInput;
  readonly device: Readonly<{
    readonly id: string;
    readonly identityGeneration: bigint;
    readonly keyId: Uint8Array;
    readonly x25519PublicKey: Uint8Array;
    readonly ed25519PublicKey: Uint8Array;
  }>;
  readonly certificateObject: ProtocolObjectInput;
  readonly client?: DeviceClientMetadata | null;
  readonly now?: Date;
}>;

export type DeviceEnrollmentCompletionInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly enrollmentId: string;
  readonly device: Readonly<{
    readonly id: string;
    readonly identityGeneration: bigint;
    readonly keyId: Uint8Array;
    readonly x25519PublicKey: Uint8Array;
    readonly ed25519PublicKey: Uint8Array;
  }>;
  readonly enrollmentObject: ProtocolObjectInput;
  readonly certificateObject: ProtocolObjectInput;
  readonly client?: DeviceClientMetadata | null;
  readonly now?: Date;
}>;

// Display metadata written with the Device row. displayName is the suggested
// auto name at enrollment; nameOverridden starts false so a later session
// refresh may replace it until the owner renames.
export type DeviceClientMetadata = Readonly<{
  readonly displayName: string;
  readonly clientKind: "CLI" | "BROWSER";
  readonly osName: string | null;
  readonly clientSummary: string | null;
}>;

const clientCreateData = (
  client: DeviceClientMetadata | null | undefined,
): Readonly<{
  displayName?: string;
  clientKind?: "CLI" | "BROWSER";
  osName?: string | null;
  clientSummary?: string | null;
}> =>
  client
    ? {
        displayName: client.displayName,
        clientKind: client.clientKind,
        osName: client.osName,
        clientSummary: client.clientSummary,
      }
    : {};

export class DeviceRepository {
  private readonly operations = new OperationRepository();
  private readonly protocolObjects = new ProtocolObjectRepository();
  private readonly audit = new AuditFactRepository();
  private readonly stagedObjects = new StagedObjectRepository();

  async beginEnrollment(
    database: TransactionDatabase,
    input: DeviceEnrollmentBeginInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await requireActiveDevice(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
      );
      if (input.initiatorDeviceId !== input.operation.actorDeviceId)
        throw new Error("enrollment initiator must match the actor device");
      const operation = await this.operations.begin(transaction, {
        ...input.operation,
        kind: "DEVICE_ENROLLMENT",
      });
      if (operation.idempotent) return operation;
      const activeDeviceCount = await transaction.device.count({
        where: { userId: input.userId, lifecycle: "ACTIVE" },
      });
      if (activeDeviceCount === 0)
        throw new Error(
          "initial trust bootstrap must use the bootstrap enrollment path",
        );
      const now = input.now ?? new Date();
      if (input.expiresAt <= now) throw new Error("Device enrollment expired");
      const enrollment = await transaction.deviceEnrollment.create({
        data: {
          id: input.enrollmentId,
          operationId: operation.operation.id,
          userId: input.userId,
          initiatorDeviceId: input.initiatorDeviceId,
          transcriptHash: databaseBytes(
            validateDigest(input.transcriptHash, "enrollment transcript hash"),
          ),
          challengeHash: databaseBytes(
            validateDigest(input.challengeHash, "enrollment challenge hash"),
          ),
          expiresAt: input.expiresAt,
          createdAt: now,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "DEVICE_ENROLLMENT_STARTED",
        actorUserId: input.operation.actorUserId,
        actorDeviceId: input.operation.actorDeviceId,
        entityKind: "OPERATION",
        entityId: operation.operation.id,
      });
      return { operation: operation.operation, enrollment };
    });
  }

  async approveEnrollment(
    database: TransactionDatabase,
    input: DeviceEnrollmentApprovalInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "device_enrollments" WHERE "id" = ${input.enrollmentId} FOR UPDATE`;
      await requireActiveDevice(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
      );
      const enrollment = await transaction.deviceEnrollment.findUnique({
        where: { id: input.enrollmentId },
      });
      if (!enrollment || enrollment.completedAt)
        throw new Error("Device enrollment is not pending");
      if (enrollment.expiresAt <= (input.now ?? new Date()))
        throw new Error("Device enrollment expired");
      if (enrollment.initiatorDeviceId === input.operation.actorDeviceId)
        throw new Error("enrollment approver must differ from the initiator");
      const operation = await this.operations.begin(transaction, {
        ...input.operation,
        kind: "DEVICE_ENROLLMENT",
      });
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      await this.stagedObjects.promote(transaction, {
        operationId: operation.operation.id,
        actorDeviceId: input.operation.actorDeviceId,
        now,
        objects: [
          {
            objectId: input.approvalObject.id,
            canonicalBytes: input.approvalObject.canonicalBytes,
            digest: input.approvalObject.digest,
          },
        ],
      });
      const approvalObject = await this.protocolObjects.create(
        transaction,
        input.approvalObject,
      );
      await transaction.enrollmentApprovalObject.create({
        data: {
          protocolObjectId: approvalObject.id,
          enrollmentId: enrollment.id,
          approvalDeviceId: input.operation.actorDeviceId,
        },
      });
      await transaction.deviceEnrollment.update({
        where: { id: enrollment.id },
        data: { approverDeviceId: input.operation.actorDeviceId },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "DEVICE_ENROLLMENT_APPROVED",
        actorUserId: input.operation.actorUserId,
        actorDeviceId: input.operation.actorDeviceId,
        entityKind: "OPERATION",
        entityId: operation.operation.id,
        outcomeObjectId: approvalObject.id,
      });
      return { operation: operation.operation, enrollment };
    });
  }

  async completeBootstrap(
    database: TransactionDatabase,
    input: DeviceBootstrapInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${input.operation.actorUserId} FOR UPDATE`;
      const operation = await this.operations.begin(transaction, {
        ...input.operation,
        kind: "DEVICE_ENROLLMENT",
      });
      if (operation.idempotent) return operation;
      const user = await transaction.user.findUnique({
        where: { id: input.operation.actorUserId },
        select: { identityGeneration: true },
      });
      if (!user || user.identityGeneration !== input.device.identityGeneration)
        throw new Error("device identity generation is stale");
      validatePublicKeys(input.device);
      await validateSha384Digest(
        input.device.x25519PublicKey,
        input.device.keyId,
        "Device key id",
      );
      const now = input.now ?? new Date();
      const certificateObject = await this.protocolObjects.create(
        transaction,
        input.certificateObject,
      );
      const device = await transaction.device.create({
        data: {
          id: input.device.id,
          userId: input.operation.actorUserId,
          identityGeneration: input.device.identityGeneration,
          keyId: databaseBytes(
            validateDigest(input.device.keyId, "Device key id"),
          ),
          x25519PublicKey: databaseBytes(input.device.x25519PublicKey),
          ed25519PublicKey: databaseBytes(input.device.ed25519PublicKey),
          lifecycle: "ACTIVE",
          activatedAt: now,
          ...clientCreateData(input.client),
        },
      });
      await transaction.deviceCertificateObject.create({
        data: {
          protocolObjectId: certificateObject.id,
          deviceId: device.id,
          userId: input.operation.actorUserId,
          identityGeneration: input.device.identityGeneration,
          lifecycle: "ACTIVE",
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "DEVICE_ENROLLED",
        actorUserId: input.operation.actorUserId,
        entityKind: "DEVICE",
        entityId: device.id,
        newLifecycle: "ACTIVE",
        outcomeObjectId: certificateObject.id,
      });
      return { operation: operation.operation, device };
    });
  }

  async completeEnrollment(
    database: TransactionDatabase,
    input: DeviceEnrollmentCompletionInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "device_enrollments" WHERE "id" = ${input.enrollmentId} FOR UPDATE`;
      await requireActiveDevice(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const enrollment = await transaction.deviceEnrollment.findUnique({
        where: { id: input.enrollmentId },
      });
      if (!enrollment || enrollment.completedAt)
        throw new Error("Device enrollment is not pending");
      if (enrollment.expiresAt <= (input.now ?? new Date()))
        throw new Error("Device enrollment expired");
      if (!enrollment.approverDeviceId)
        throw new Error("Device enrollment is not approved");
      const user = await transaction.user.findUnique({
        where: { id: enrollment.userId },
        select: { identityGeneration: true },
      });
      if (!user || user.identityGeneration !== input.device.identityGeneration)
        throw new Error("device identity generation is stale");
      validatePublicKeys(input.device);
      await validateSha384Digest(
        input.device.x25519PublicKey,
        input.device.keyId,
        "Device key id",
      );
      const now = input.now ?? new Date();
      await this.stagedObjects.promote(transaction, {
        operationId: operation.operation.id,
        actorDeviceId: input.operation.actorDeviceId,
        now,
        objects: [
          {
            objectId: input.enrollmentObject.id,
            canonicalBytes: input.enrollmentObject.canonicalBytes,
            digest: input.enrollmentObject.digest,
          },
          {
            objectId: input.certificateObject.id,
            canonicalBytes: input.certificateObject.canonicalBytes,
            digest: input.certificateObject.digest,
          },
        ],
      });
      const enrollmentObject = await this.protocolObjects.create(
        transaction,
        input.enrollmentObject,
      );
      const certificateObject = await this.protocolObjects.create(
        transaction,
        input.certificateObject,
      );
      const device = await transaction.device.create({
        data: {
          id: input.device.id,
          userId: enrollment.userId,
          identityGeneration: input.device.identityGeneration,
          keyId: databaseBytes(
            validateDigest(input.device.keyId, "Device key id"),
          ),
          x25519PublicKey: databaseBytes(input.device.x25519PublicKey),
          ed25519PublicKey: databaseBytes(input.device.ed25519PublicKey),
          lifecycle: "ACTIVE",
          activatedAt: now,
          ...clientCreateData(input.client),
        },
      });
      await transaction.enrollmentObject.create({
        data: {
          protocolObjectId: enrollmentObject.id,
          enrollmentId: enrollment.id,
        },
      });
      await transaction.deviceCertificateObject.create({
        data: {
          protocolObjectId: certificateObject.id,
          deviceId: device.id,
          userId: enrollment.userId,
          identityGeneration: input.device.identityGeneration,
          lifecycle: "ACTIVE",
        },
      });
      await transaction.deviceEnrollment.update({
        where: { id: enrollment.id },
        data: { completedAt: now },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "DEVICE_ENROLLED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "DEVICE",
        entityId: device.id,
        newLifecycle: "ACTIVE",
        outcomeObjectId: certificateObject.id,
      });
      return { operation: operation.operation, device };
    });
  }

  async revoke(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly deviceId: string;
      readonly now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "devices" WHERE "id" = ${input.deviceId} FOR UPDATE`;
      const device = await transaction.device.findUnique({
        where: { id: input.deviceId },
      });
      if (!device) throw new Error("Device not found");
      await requireActiveDevice(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      const revoked = await transaction.device.update({
        where: { id: device.id },
        data: { lifecycle: "REVOKED", revokedAt: now },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "DEVICE_REVOKED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "DEVICE",
        entityId: device.id,
        priorLifecycle: device.lifecycle,
        newLifecycle: "REVOKED",
      });
      return { operation: operation.operation, device: revoked };
    });
  }
}
