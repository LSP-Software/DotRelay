import {
  decideLaneDisclosure,
  decideTeamAction,
  type TeamAction,
} from "../administration";
import type {
  MembershipRole,
  Prisma,
  PrismaClient,
} from "../generated/prisma/client";
import { inShortTransaction, type TransactionDatabase } from "./transaction";
import {
  copyBytes,
  validateDigest,
  validateLaneProjection,
  validateProtocolProjection,
  validatePublicKeys,
  validateSha384Digest,
  validateStagedObject,
} from "./validation";

export type PersistenceClient = PrismaClient | Prisma.TransactionClient;
type DatabaseBytes = Uint8Array<ArrayBuffer>;

const databaseBytes = (value: Uint8Array): DatabaseBytes =>
  new Uint8Array(value) as DatabaseBytes;

const inPersistenceTransaction = async <T>(
  database: PersistenceClient,
  callback: (transaction: PersistenceClient) => Promise<T>,
): Promise<T> => {
  if ("$transaction" in database) return inShortTransaction(database, callback);
  return callback(database);
};

export class OperationConflictError extends Error {
  constructor() {
    super(
      "operation id or idempotency digest was already used with different bytes",
    );
    this.name = "OperationConflictError";
  }
}

const requireActiveDevice = async (
  database: PersistenceClient,
  actorUserId: string,
  actorDeviceId: string | undefined,
) => {
  if (!actorDeviceId) throw new Error("an active actor device is required");
  const device = await database.device.findFirst({
    where: { id: actorDeviceId, userId: actorUserId, lifecycle: "ACTIVE" },
  });
  if (!device) throw new Error("actor device is not active");
  return device;
};

const requireTeamAction = async (
  database: PersistenceClient,
  actorUserId: string,
  actorDeviceId: string | undefined,
  teamId: string,
  action: TeamAction,
) => {
  await requireActiveDevice(database, actorUserId, actorDeviceId);
  const membership = await database.membership.findFirst({
    where: {
      teamId,
      userId: actorUserId,
    },
    select: { lifecycle: true, role: true },
  });
  const decision = decideTeamAction(membership, action);
  if (!decision.allowed)
    throw new Error(`actor is not authorized for the Team: ${decision.reason}`);
  return membership;
};

const managedRoleActions: Readonly<Record<MembershipRole, TeamAction>> = {
  OWNER: "MANAGE_OWNER",
  ADMIN: "MANAGE_ADMIN",
  MEMBER: "MANAGE_MEMBER",
};

const managedRoleAction = (role: MembershipRole): TeamAction =>
  managedRoleActions[role];

export class StagedObjectConflictError extends Error {
  constructor() {
    super("staged object was uploaded with different bytes");
    this.name = "StagedObjectConflictError";
  }
}

export class StaleHeadError extends Error {
  readonly currentHeadId: string | null;

  constructor(currentHeadId: string | null) {
    super("the Environment head changed while the command was being prepared");
    this.name = "StaleHeadError";
    this.currentHeadId = currentHeadId;
  }
}

export class StaleEpochError extends Error {
  readonly currentEpoch: bigint;

  constructor(currentEpoch: bigint) {
    super("the Project epoch changed while the transition was being prepared");
    this.name = "StaleEpochError";
    this.currentEpoch = currentEpoch;
  }
}

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
    | "RECOVERY"
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
        select: { id: true },
      });
      if (expired.length === 0) return 0;
      const ids = expired.map(({ id }) => id);
      await transaction.stagedObject.deleteMany({
        where: { operationId: { in: ids }, committedAt: null },
      });
      const result = await transaction.operation.updateMany({
        where: { id: { in: ids }, status: "STAGED" },
        data: { status: "EXPIRED" },
      });
      return result.count;
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
    | "RECOVERY_COMPLETED"
    | "PROJECT_CREATED"
    | "PROJECT_ARCHIVED"
    | "PROJECT_RESTORED"
    | "ENVIRONMENT_CREATED"
    | "ENVIRONMENT_ARCHIVED"
    | "ENVIRONMENT_RESTORED"
    | "REVISION_PUBLISHED"
    | "ROLLBACK_PUBLISHED"
    | "EPOCH_ROTATED";
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
    | "RECOVERY_ENVELOPE";
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
      readonly endpointTemplate: string;
      readonly httpStatus: number;
      readonly transferBytes: bigint;
      readonly requestedAt: Date;
      readonly expiresAt: Date;
    }>,
  ) {
    if (input.expiresAt <= input.requestedAt)
      throw new Error("Security Request Log must expire after receipt");
    return database.securityRequestLog.create({
      data: {
        ipAddress: input.ipAddress,
        endpointTemplate: input.endpointTemplate,
        httpStatus: input.httpStatus,
        transferBytes: input.transferBytes,
        requestedAt: input.requestedAt,
        expiresAt: input.expiresAt,
      },
    });
  }

  async expire(database: TransactionDatabase, now: Date) {
    return inShortTransaction(database, (transaction) =>
      transaction.securityRequestLog.deleteMany({
        where: { expiresAt: { lte: now } },
      }),
    );
  }
}

export type TeamCreationInput = Readonly<{
  readonly teamId?: string;
  readonly serverProfileId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly now?: Date;
}>;

export class AdministrationRepository {
  private readonly operations = new OperationRepository();
  private readonly audit = new AuditFactRepository();

  async createTeamWithOwner(
    database: TransactionDatabase,
    input: TeamCreationInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      const now = input.now ?? new Date();
      await requireActiveDevice(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
      );
      if (input.operation.actorUserId !== input.ownerUserId)
        throw new Error("Team owner must be the operation actor");
      const owner = await transaction.user.findUnique({
        where: { id: input.ownerUserId },
        select: { serverProfileId: true },
      });
      if (!owner || owner.serverProfileId !== input.serverProfileId)
        throw new Error("Team owner belongs to another Server Profile");
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const team = await transaction.team.create({
        data: {
          id: input.teamId ?? crypto.randomUUID(),
          serverProfileId: input.serverProfileId,
          name: input.name,
          createdAt: now,
        },
      });
      const membership = await transaction.membership.create({
        data: {
          id: crypto.randomUUID(),
          teamId: team.id,
          userId: input.ownerUserId,
          role: "OWNER",
          lifecycle: "ACTIVE",
          createdAt: now,
          activatedAt: now,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "TEAM_CREATED",
        actorUserId: input.operation.actorUserId,
        actorDeviceId: input.operation.actorDeviceId,
        entityKind: "TEAM",
        entityId: team.id,
        newLifecycle: "ACTIVE",
      });
      return { operation: operation.operation, team, membership };
    });
  }

  async archiveProject(
    database: TransactionDatabase,
    input: Readonly<{
      projectId: string;
      operation: OperationInput;
      now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const lockedProject = await transaction.project.findUnique({
        where: { id: input.projectId },
      });
      if (!lockedProject) throw new Error("Project not found");
      if (lockedProject.lifecycle !== "ACTIVE")
        throw new Error("Project is not active");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        lockedProject.teamId,
        "ADMINISTER_PROJECT",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const project = await transaction.project.update({
        where: { id: input.projectId },
        data: { lifecycle: "ARCHIVED", archivedAt: input.now ?? new Date() },
      });
      const now = input.now ?? new Date();
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "PROJECT_ARCHIVED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "PROJECT",
        entityId: project.id,
        priorLifecycle: "ACTIVE",
        newLifecycle: "ARCHIVED",
      });
      return { operation: operation.operation, project };
    });
  }

  async restoreProject(
    database: TransactionDatabase,
    input: Readonly<{
      projectId: string;
      operation: OperationInput;
      now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const lockedProject = await transaction.project.findUnique({
        where: { id: input.projectId },
      });
      if (!lockedProject) throw new Error("Project not found");
      if (lockedProject.lifecycle !== "ARCHIVED")
        throw new Error("Project is not archived");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        lockedProject.teamId,
        "ADMINISTER_PROJECT",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const project = await transaction.project.update({
        where: { id: input.projectId },
        data: { lifecycle: "ACTIVE", archivedAt: null },
      });
      const now = input.now ?? new Date();
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "PROJECT_RESTORED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "PROJECT",
        entityId: project.id,
        priorLifecycle: "ARCHIVED",
        newLifecycle: "ACTIVE",
      });
      return { operation: operation.operation, project };
    });
  }

  async archiveEnvironment(
    database: TransactionDatabase,
    input: Readonly<{
      environmentId: string;
      operation: OperationInput;
      now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "environments" WHERE "id" = ${input.environmentId} FOR UPDATE`;
      const lockedEnvironment = await transaction.environment.findUnique({
        where: { id: input.environmentId },
        include: { project: true },
      });
      if (!lockedEnvironment) throw new Error("Environment not found");
      if (lockedEnvironment.lifecycle !== "ACTIVE")
        throw new Error("Environment is not active");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        lockedEnvironment.project.teamId,
        "ADMINISTER_ENVIRONMENT",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const environment = await transaction.environment.update({
        where: { id: input.environmentId },
        data: {
          lifecycle: "ARCHIVED",
          archivedAt: input.now ?? new Date(),
        },
      });
      const now = input.now ?? new Date();
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "ENVIRONMENT_ARCHIVED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "ENVIRONMENT",
        entityId: environment.id,
        priorLifecycle: "ACTIVE",
        newLifecycle: "ARCHIVED",
      });
      return { operation: operation.operation, environment };
    });
  }

  async restoreEnvironment(
    database: TransactionDatabase,
    input: Readonly<{
      environmentId: string;
      operation: OperationInput;
      now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "environments" WHERE "id" = ${input.environmentId} FOR UPDATE`;
      const lockedEnvironment = await transaction.environment.findUnique({
        where: { id: input.environmentId },
        include: { project: true },
      });
      if (!lockedEnvironment) throw new Error("Environment not found");
      if (lockedEnvironment.lifecycle !== "ARCHIVED")
        throw new Error("Environment is not archived");
      if (lockedEnvironment.project.lifecycle !== "ACTIVE")
        throw new Error("Project is archived");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        lockedEnvironment.project.teamId,
        "ADMINISTER_ENVIRONMENT",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const environment = await transaction.environment.update({
        where: { id: input.environmentId },
        data: { lifecycle: "ACTIVE", archivedAt: null },
      });
      const now = input.now ?? new Date();
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "ENVIRONMENT_RESTORED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "ENVIRONMENT",
        entityId: environment.id,
        priorLifecycle: "ARCHIVED",
        newLifecycle: "ACTIVE",
      });
      return { operation: operation.operation, environment };
    });
  }
}

export class MembershipAdministrationRepository {
  private readonly operations = new OperationRepository();
  private readonly audit = new AuditFactRepository();

  async invite(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly teamId: string;
      readonly invitationId?: string;
      readonly providerSubject: string;
      readonly now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId} FOR UPDATE`;
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        "INVITE_MEMBER",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const team = await transaction.team.findUnique({
        where: { id: input.teamId },
        select: { lifecycle: true },
      });
      if (team?.lifecycle !== "ACTIVE") throw new Error("Team is not active");
      if (input.providerSubject.length === 0)
        throw new Error("GitHub provider subject is required");
      const now = input.now ?? new Date();
      const invitation = await transaction.membershipInvitation.create({
        data: {
          id: input.invitationId ?? crypto.randomUUID(),
          teamId: input.teamId,
          providerSubject: input.providerSubject,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000),
          createdAt: now,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "MEMBERSHIP_INVITED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "INVITATION",
        entityId: invitation.id,
      });
      return { operation: operation.operation, invitation };
    });
  }

  async accept(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly invitationId: string;
      readonly userId: string;
      readonly now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "membership_invitations" WHERE "id" = ${input.invitationId} FOR UPDATE`;
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      if (input.operation.actorUserId !== input.userId)
        throw new Error("Membership invitation must be accepted by its User");
      const invitation = await transaction.membershipInvitation.findUnique({
        where: { id: input.invitationId },
      });
      const user = await transaction.user.findUnique({
        where: { id: input.userId },
      });
      if (!invitation || !user) throw new Error("Invitation or User not found");
      if (
        invitation.acceptedAt ||
        invitation.expiresAt <= (input.now ?? new Date())
      )
        throw new Error("Membership invitation is expired or already used");
      if (user.githubSubject !== invitation.providerSubject)
        throw new Error("Membership invitation is addressed to another User");
      const team = await transaction.team.findUnique({
        where: { id: invitation.teamId },
        select: { serverProfileId: true },
      });
      if (!team || team.serverProfileId !== user.serverProfileId)
        throw new Error(
          "Membership invitation belongs to another Server Profile",
        );
      const now = input.now ?? new Date();
      const membership = await transaction.membership.create({
        data: {
          id: crypto.randomUUID(),
          teamId: invitation.teamId,
          userId: user.id,
          invitationId: invitation.id,
          createdAt: now,
        },
      });
      await transaction.membershipInvitation.update({
        where: { id: invitation.id },
        data: { acceptedByUserId: user.id, acceptedAt: now },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "MEMBERSHIP_ACCEPTED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "MEMBERSHIP",
        entityId: membership.id,
        newLifecycle: "PENDING_KEY_GRANT",
      });
      return { operation: operation.operation, membership };
    });
  }

  async changeRole(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly teamId: string;
      readonly membershipId: string;
      readonly role: "OWNER" | "ADMIN" | "MEMBER";
      readonly now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId} FOR UPDATE`;
      const membership = await transaction.membership.findUnique({
        where: { id: input.membershipId },
      });
      if (!membership || membership.teamId !== input.teamId)
        throw new Error("Membership not found");
      if (membership.lifecycle === "REMOVED")
        throw new Error("Membership is removed");
      const managedRole =
        membership.role === "OWNER" || input.role === "OWNER"
          ? "OWNER"
          : membership.role === "ADMIN" || input.role === "ADMIN"
            ? "ADMIN"
            : "MEMBER";
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        managedRoleAction(managedRole),
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const changed = await transaction.membership.update({
        where: { id: membership.id },
        data: { role: input.role },
      });
      const now = input.now ?? new Date();
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "MEMBERSHIP_ROLE_CHANGED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "MEMBERSHIP",
        entityId: membership.id,
        priorLifecycle: membership.role,
        newLifecycle: input.role,
      });
      return { operation: operation.operation, membership: changed };
    });
  }

  async remove(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput;
      readonly teamId: string;
      readonly membershipId: string;
      readonly now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId} FOR UPDATE`;
      const membership = await transaction.membership.findUnique({
        where: { id: input.membershipId },
      });
      if (!membership || membership.teamId !== input.teamId)
        throw new Error("Membership not found");
      if (membership.lifecycle === "REMOVED")
        throw new Error("Membership is already removed");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        managedRoleAction(membership.role),
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      const removed = await transaction.membership.update({
        where: { id: membership.id },
        data: { lifecycle: "REMOVED", removedAt: now },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "MEMBERSHIP_REMOVED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "MEMBERSHIP",
        entityId: membership.id,
        priorLifecycle: membership.lifecycle,
        newLifecycle: "REMOVED",
      });
      return { operation: operation.operation, membership: removed };
    });
  }
}

export type ProjectCreationInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly teamId: string;
  readonly projectId?: string;
  readonly githubRepositoryId: bigint;
  readonly now?: Date;
}>;

export class ProjectRepository {
  private readonly operations = new OperationRepository();
  private readonly audit = new AuditFactRepository();

  async create(database: TransactionDatabase, input: ProjectCreationInput) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId} FOR UPDATE`;
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        "ADMINISTER_PROJECT",
      );
      const team = await transaction.team.findUnique({
        where: { id: input.teamId },
        select: { lifecycle: true },
      });
      if (team?.lifecycle !== "ACTIVE") throw new Error("Team is archived");
      if (input.githubRepositoryId <= 0n)
        throw new Error("GitHub Repository id must be positive");
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      const project = await transaction.project.create({
        data: {
          id: input.projectId ?? crypto.randomUUID(),
          teamId: input.teamId,
          githubRepositoryId: input.githubRepositoryId,
          createdByUserId: input.operation.actorUserId,
          createdAt: now,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "PROJECT_CREATED",
        actorUserId: input.operation.actorUserId,
        actorDeviceId: input.operation.actorDeviceId,
        entityKind: "PROJECT",
        entityId: project.id,
        newLifecycle: "ACTIVE",
      });
      return { operation: operation.operation, project };
    });
  }
}

export type EnvironmentMetadata = Readonly<{
  readonly id: string;
  readonly projectId: string;
  readonly lifecycle: "ACTIVE" | "ARCHIVED";
  readonly currentHeadId: string | null;
}>;

type EnvironmentAccessInput = Readonly<{
  readonly actorUserId: string;
  readonly actorDeviceId: string;
  readonly environmentId: string;
}>;

/**
 * Read-side authorization keeps protected rows outside the result set. In
 * particular, owner/admin roles do not broaden User-defined Value ownership.
 */
export class AdministrationDisclosureRepository {
  private async requireEnvironmentAccess(
    database: PersistenceClient,
    input: EnvironmentAccessInput,
  ) {
    await requireActiveDevice(database, input.actorUserId, input.actorDeviceId);
    const environment = await database.environment.findFirst({
      where: {
        id: input.environmentId,
        project: {
          team: {
            memberships: {
              some: { userId: input.actorUserId, lifecycle: "ACTIVE" },
            },
          },
        },
      },
      include: { project: { select: { teamId: true, lifecycle: true } } },
    });
    if (!environment) throw new Error("Environment not found");
    const membership = await database.membership.findUnique({
      where: {
        teamId_userId: {
          teamId: environment.project.teamId,
          userId: input.actorUserId,
        },
      },
      select: { lifecycle: true, role: true },
    });
    const decision = decideTeamAction(membership, "VIEW");
    if (!decision.allowed)
      throw new Error(`Environment is not disclosed: ${decision.reason}`);
    return { environment, membership };
  }

  async getEnvironmentMetadata(
    database: PersistenceClient,
    input: EnvironmentAccessInput,
  ): Promise<EnvironmentMetadata> {
    const { environment } = await this.requireEnvironmentAccess(
      database,
      input,
    );
    return {
      id: environment.id,
      projectId: environment.projectId,
      lifecycle: environment.lifecycle,
      currentHeadId: environment.currentHeadId,
    };
  }

  async listEnvironmentLanes(
    database: PersistenceClient,
    input: EnvironmentAccessInput,
  ) {
    const { environment, membership } = await this.requireEnvironmentAccess(
      database,
      input,
    );
    const resourceLifecycle =
      environment.lifecycle === "ACTIVE" &&
      environment.project.lifecycle === "ACTIVE"
        ? "ACTIVE"
        : "ARCHIVED";
    const resourceDecision = decideLaneDisclosure(
      membership,
      resourceLifecycle,
      { scope: "SHARED_VALUE" },
      input.actorUserId,
    );
    if (!resourceDecision.allowed)
      throw new Error(
        `Environment lanes are not disclosed: ${resourceDecision.reason}`,
      );
    return database.laneObject.findMany({
      where: {
        environmentId: input.environmentId,
        OR: [
          { scope: { not: "USER_DEFINED_VALUE" } },
          { scope: "USER_DEFINED_VALUE", ownerUserId: input.actorUserId },
        ],
      },
      include: { protocolObject: true },
      orderBy: { id: "asc" },
    });
  }
}

export type LaneProjectionInput = Readonly<{
  readonly id: string;
  readonly protocolObjectId: string;
  readonly operationId?: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly scope:
    | "ENVIRONMENT_DEFINITION"
    | "VARIABLE_DEFINITION"
    | "SHARED_VALUE"
    | "USER_DEFINED_VALUE";
  readonly ownerUserId?: string;
  readonly originalProviderUserId?: string;
  readonly projectEpoch: bigint;
  readonly valueGeneration?: bigint;
  readonly plaintextLength: number;
  readonly ciphertextLength: number;
  readonly ciphertextHash: Uint8Array;
}>;

export type RevisionPublicationInput = Readonly<{
  readonly operation: Readonly<{
    readonly id: string;
    readonly actorUserId: string;
    readonly actorDeviceId: string;
    readonly kind: "REVISION_PUBLICATION" | "ROLLBACK";
    readonly commandBytes: Uint8Array;
    readonly commandDigest: Uint8Array;
    readonly expiresAt?: Date;
  }>;
  readonly environmentId: string;
  readonly expectedHeadId: string | null;
  readonly revision: Readonly<{
    readonly id: string;
    readonly protocolObjectId: string;
    readonly parentHash?: Uint8Array;
    readonly projectEpoch: bigint;
    readonly mutation:
      | "GENESIS"
      | "MANIFEST_UPDATE"
      | "ROLLBACK"
      | "EPOCH_TRANSITION"
      | "USER_KEY_ROTATION";
    readonly authoredAtMs: bigint;
    readonly rollbackTargetId?: string;
  }>;
  readonly revisionObject: ProtocolObjectInput;
  readonly descriptor: Readonly<{
    readonly protocolObject: ProtocolObjectInput;
    readonly schemaVersion: number;
    readonly descriptorHash: Uint8Array;
    readonly laneCount: number;
  }>;
  readonly lanes: ReadonlyArray<
    Readonly<{
      readonly lane: LaneProjectionInput;
      readonly protocolObject: ProtocolObjectInput;
    }>
  >;
  readonly commitments: ReadonlyArray<
    Readonly<{
      readonly ordinal: number;
      readonly laneObjectId: string;
      readonly objectHash: Uint8Array;
      readonly projectEpoch: bigint;
      readonly valueGeneration?: bigint;
      readonly scope: LaneProjectionInput["scope"];
      readonly ownerUserId?: string;
      readonly originalProviderUserId?: string;
      readonly ciphertextLength: number;
    }>
  >;
  readonly audit: Readonly<{
    readonly kind: "REVISION_PUBLISHED" | "ROLLBACK_PUBLISHED";
    readonly entityKind: "ENVIRONMENT";
    readonly entityId: string;
  }>;
}>;

export class PublicationRepository {
  private readonly protocolObjects = new ProtocolObjectRepository();
  private readonly stagedObjects = new StagedObjectRepository();

  async publishRevision(
    database: TransactionDatabase,
    input: RevisionPublicationInput,
  ) {
    return inShortTransaction(database, (transaction) =>
      this.publishRevisionInTransaction(transaction, input),
    );
  }

  async publishRevisionInTransaction(
    transaction: PersistenceClient,
    input: RevisionPublicationInput,
  ) {
    await transaction.$executeRaw`SELECT "id" FROM "environments" WHERE "id" = ${input.environmentId} FOR UPDATE`;
    const existingOperation = await transaction.operation.findUnique({
      where: { id: input.operation.id },
      include: { revision: true },
    });
    if (existingOperation) {
      if (
        existingOperation.actorUserId !== input.operation.actorUserId ||
        existingOperation.actorDeviceId !== input.operation.actorDeviceId ||
        !sameBytes(
          existingOperation.commandDigest,
          input.operation.commandDigest,
        )
      )
        throw new OperationConflictError();
      if (
        existingOperation.status === "COMMITTED" &&
        existingOperation.revision
      )
        return { revision: existingOperation.revision, idempotent: true };
    }

    const environment = await transaction.environment.findUnique({
      where: { id: input.environmentId },
      include: { project: true },
    });
    if (!environment) throw new Error("Environment not found");
    if (environment.currentHeadId !== input.expectedHeadId)
      throw new StaleHeadError(environment.currentHeadId);
    if (
      environment.lifecycle !== "ACTIVE" ||
      environment.project.lifecycle !== "ACTIVE"
    )
      throw new Error("Project or Environment is archived");
    if (
      input.revision.mutation !== "EPOCH_TRANSITION" &&
      input.revision.projectEpoch !== environment.project.currentEpoch
    )
      throw new StaleEpochError(environment.project.currentEpoch);
    const parentRevision = input.expectedHeadId
      ? await transaction.revision.findUnique({
          where: { id: input.expectedHeadId },
          include: { protocolObject: true },
        })
      : null;
    if (input.expectedHeadId) {
      if (
        !parentRevision ||
        parentRevision.environmentId !== input.environmentId ||
        !input.revision.parentHash ||
        !sameBytes(
          parentRevision.protocolObject.digest,
          input.revision.parentHash,
        )
      )
        throw new StaleHeadError(environment.currentHeadId);
    } else if (input.revision.parentHash) {
      throw new Error("genesis cannot carry a parent hash");
    }

    const device = await transaction.device.findFirst({
      where: {
        id: input.operation.actorDeviceId,
        userId: input.operation.actorUserId,
        lifecycle: "ACTIVE",
      },
    });
    if (!device) throw new Error("Device is not active");
    const membership = await transaction.membership.findFirst({
      where: {
        teamId: environment.project.teamId,
        userId: input.operation.actorUserId,
        lifecycle: "ACTIVE",
      },
    });
    if (!membership) throw new Error("Membership is not active");

    await validateSha384Digest(
      input.operation.commandBytes,
      input.operation.commandDigest,
      "operation digest",
    );
    validateProtocolProjection(input.revisionObject);
    if (input.revisionObject.id !== input.revision.protocolObjectId)
      throw new Error(
        "Revision protocol object id does not match its projection",
      );
    if (
      input.revisionObject.projectId !== environment.projectId ||
      input.revisionObject.environmentId !== input.environmentId ||
      input.descriptor.protocolObject.projectId !== environment.projectId ||
      input.descriptor.protocolObject.environmentId !== input.environmentId
    )
      throw new Error(
        "publication protocol objects are outside the Environment",
      );
    validateProtocolProjection(input.descriptor.protocolObject);
    if (
      !sameBytes(
        input.descriptor.descriptorHash,
        input.descriptor.protocolObject.digest,
      )
    )
      throw new Error("Manifest descriptor hash does not match its object");
    if (
      input.descriptor.laneCount !== input.lanes.length ||
      input.commitments.length !== input.lanes.length
    )
      throw new Error("Manifest descriptor lane projection is incomplete");
    const laneIds = new Set(input.lanes.map(({ lane }) => lane.id));
    const ordinals = new Set<number>();
    for (const lane of input.lanes) {
      validateLaneProjection(lane.lane);
      if (
        lane.lane.projectId !== environment.projectId ||
        lane.lane.environmentId !== input.environmentId ||
        lane.lane.projectEpoch !== input.revision.projectEpoch ||
        lane.protocolObject.projectId !== environment.projectId ||
        lane.protocolObject.environmentId !== input.environmentId
      )
        throw new Error("lane projection is outside the publication context");
      if (lane.protocolObject.id !== lane.lane.protocolObjectId)
        throw new Error(
          "lane protocol object id does not match its projection",
        );
      validateProtocolProjection(lane.protocolObject);
    }
    for (const commitment of input.commitments) {
      validateDigest(commitment.objectHash, "lane commitment hash");
      if (!laneIds.has(commitment.laneObjectId))
        throw new Error("Manifest commitment references an unknown lane");
      if (ordinals.has(commitment.ordinal))
        throw new Error("Manifest commitment ordinals must be unique");
      ordinals.add(commitment.ordinal);
      const lane = input.lanes.find(
        ({ lane: candidate }) => candidate.id === commitment.laneObjectId,
      );
      if (!lane)
        throw new Error("Manifest commitment references an unknown lane");
      if (
        commitment.projectEpoch !== lane.lane.projectEpoch ||
        commitment.valueGeneration !== lane.lane.valueGeneration ||
        commitment.scope !== lane.lane.scope ||
        commitment.ownerUserId !== lane.lane.ownerUserId ||
        commitment.originalProviderUserId !==
          lane.lane.originalProviderUserId ||
        commitment.ciphertextLength !== lane.lane.ciphertextLength ||
        !sameBytes(commitment.objectHash, lane.protocolObject.digest)
      )
        throw new Error(
          "Manifest commitment does not match its lane projection",
        );
    }
    if ([...ordinals].some((ordinal, index) => ordinal !== index))
      throw new Error("Manifest commitment ordinals must be contiguous");
    if (input.revision.mutation === "ROLLBACK") {
      if (!input.revision.rollbackTargetId)
        throw new Error("rollback must identify its target revision");
      const rollbackTarget = await transaction.revision.findUnique({
        where: { id: input.revision.rollbackTargetId },
        select: { environmentId: true },
      });
      if (
        !rollbackTarget ||
        rollbackTarget.environmentId !== input.environmentId
      )
        throw new Error("rollback target is outside the Environment");
    }

    const operation = existingOperation
      ? existingOperation
      : await transaction.operation.create({
          data: {
            id: input.operation.id,
            actorUserId: input.operation.actorUserId,
            ...(input.operation.actorDeviceId
              ? { actorDeviceId: input.operation.actorDeviceId }
              : {}),
            kind: input.operation.kind,
            commandDigest: databaseBytes(
              validateDigest(input.operation.commandDigest, "operation digest"),
            ),
            ...(input.operation.expiresAt
              ? { expiresAt: input.operation.expiresAt }
              : {}),
          },
        });

    const stagedNow = new Date();
    await this.stagedObjects.promote(transaction, {
      operationId: operation.id,
      actorDeviceId: input.operation.actorDeviceId,
      now: stagedNow,
      objects: [
        {
          objectId: input.revisionObject.id,
          canonicalBytes: input.revisionObject.canonicalBytes,
          digest: input.revisionObject.digest,
        },
        {
          objectId: input.descriptor.protocolObject.id,
          canonicalBytes: input.descriptor.protocolObject.canonicalBytes,
          digest: input.descriptor.protocolObject.digest,
        },
        ...input.lanes.map(({ protocolObject }) => ({
          objectId: protocolObject.id,
          canonicalBytes: protocolObject.canonicalBytes,
          digest: protocolObject.digest,
        })),
      ],
    });

    const revisionObject = await this.protocolObjects.create(
      transaction,
      input.revisionObject,
    );
    const revision = await transaction.revision.create({
      data: {
        id: input.revision.id,
        protocolObjectId: revisionObject.id,
        operationId: operation.id,
        environmentId: input.environmentId,
        parentId: input.expectedHeadId,
        ...(input.revision.parentHash
          ? {
              parentHash: databaseBytes(
                validateDigest(input.revision.parentHash, "parent hash"),
              ),
            }
          : {}),
        authorUserId: input.operation.actorUserId,
        signingDeviceId: device.id,
        projectEpoch: input.revision.projectEpoch,
        mutation: input.revision.mutation,
        authoredAtMs: input.revision.authoredAtMs,
        ...(input.revision.rollbackTargetId
          ? { rollbackTargetId: input.revision.rollbackTargetId }
          : {}),
      },
    });

    for (const laneInput of input.lanes) {
      const protocolObject = await this.protocolObjects.create(
        transaction,
        laneInput.protocolObject,
      );
      await transaction.laneObject.create({
        data: {
          id: laneInput.lane.id,
          protocolObjectId: protocolObject.id,
          operationId: operation.id,
          projectId: laneInput.lane.projectId,
          environmentId: laneInput.lane.environmentId,
          scope: laneInput.lane.scope,
          ...(laneInput.lane.ownerUserId
            ? { ownerUserId: laneInput.lane.ownerUserId }
            : {}),
          ...(laneInput.lane.originalProviderUserId
            ? { originalProviderUserId: laneInput.lane.originalProviderUserId }
            : {}),
          projectEpoch: laneInput.lane.projectEpoch,
          ...(laneInput.lane.valueGeneration !== undefined
            ? { valueGeneration: laneInput.lane.valueGeneration }
            : {}),
          plaintextLength: laneInput.lane.plaintextLength,
          ciphertextLength: laneInput.lane.ciphertextLength,
          ciphertextHash: databaseBytes(
            validateDigest(laneInput.lane.ciphertextHash, "ciphertext hash"),
          ),
        },
      });
    }

    const descriptorObject = await this.protocolObjects.create(
      transaction,
      input.descriptor.protocolObject,
    );
    await transaction.manifestDescriptor.create({
      data: {
        protocolObjectId: descriptorObject.id,
        revisionId: revision.id,
        projectId: environment.projectId,
        environmentId: input.environmentId,
        schemaVersion: input.descriptor.schemaVersion,
        descriptorHash: databaseBytes(
          validateDigest(
            input.descriptor.descriptorHash,
            "Manifest descriptor hash",
          ),
        ),
        laneCount: input.descriptor.laneCount,
      },
    });

    for (const commitment of input.commitments) {
      await transaction.revisionLaneCommitment.create({
        data: {
          revisionId: revision.id,
          ordinal: commitment.ordinal,
          laneObjectId: commitment.laneObjectId,
          objectHash: databaseBytes(
            validateDigest(commitment.objectHash, "lane commitment hash"),
          ),
          projectEpoch: commitment.projectEpoch,
          ...(commitment.valueGeneration !== undefined
            ? { valueGeneration: commitment.valueGeneration }
            : {}),
          scope: commitment.scope,
          ...(commitment.ownerUserId
            ? { ownerUserId: commitment.ownerUserId }
            : {}),
          ...(commitment.originalProviderUserId
            ? { originalProviderUserId: commitment.originalProviderUserId }
            : {}),
          ciphertextLength: commitment.ciphertextLength,
        },
      });
    }

    await transaction.environment.update({
      where: { id: input.environmentId },
      data: { currentHeadId: revision.id },
    });
    await transaction.operation.update({
      where: { id: operation.id },
      data: { status: "COMMITTED", committedAt: new Date() },
    });
    await transaction.auditEvent.create({
      data: {
        operationId: operation.id,
        kind: input.audit.kind,
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: input.audit.entityKind,
        entityId: input.audit.entityId,
        outcomeObjectId: revisionObject.id,
        outcomeRevisionId: revision.id,
      },
    });
    return { revision, idempotent: false };
  }
}

export type EnvironmentGenesisInput = Readonly<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly createdByUserId: string;
  readonly publication: RevisionPublicationInput;
}>;

export class EnvironmentRepository {
  private readonly publication = new PublicationRepository();

  async createWithGenesis(
    database: TransactionDatabase,
    input: EnvironmentGenesisInput,
  ) {
    if (input.publication.expectedHeadId !== null)
      throw new Error("genesis must start with an empty Environment head");
    if (input.publication.revision.mutation !== "GENESIS")
      throw new Error("genesis must use the GENESIS mutation");
    if (
      input.createdByUserId !== input.publication.operation.actorUserId ||
      input.environmentId !== input.publication.environmentId ||
      input.projectId !== input.publication.revisionObject.projectId
    )
      throw new Error("Environment genesis context does not match its actor");
    return inShortTransaction(database, async (transaction) => {
      const project = await transaction.project.findUnique({
        where: { id: input.projectId },
        select: { lifecycle: true, teamId: true },
      });
      if (project?.lifecycle !== "ACTIVE")
        throw new Error("Project is not active");
      await requireTeamAction(
        transaction,
        input.publication.operation.actorUserId,
        input.publication.operation.actorDeviceId,
        project.teamId,
        "ADMINISTER_ENVIRONMENT",
      );
      await transaction.environment.create({
        data: {
          id: input.environmentId,
          projectId: input.projectId,
          createdByUserId: input.createdByUserId,
        },
      });
      return this.publication.publishRevisionInTransaction(
        transaction,
        input.publication,
      );
    });
  }
}

export type MembershipActivationInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly teamId: string;
  readonly membershipId: string;
  readonly requiredGrantCount: number;
  readonly activationObject: ProtocolObjectInput;
  readonly now?: Date;
}>;

export class MembershipRepository {
  private readonly operations = new OperationRepository();
  private readonly audit = new AuditFactRepository();
  private readonly stagedObjects = new StagedObjectRepository();

  async activate(
    database: TransactionDatabase,
    input: MembershipActivationInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "teams" WHERE "id" = ${input.teamId} FOR UPDATE`;
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const membership = await transaction.membership.findUnique({
        where: { id: input.membershipId },
      });
      if (!membership || membership.teamId !== input.teamId)
        throw new Error("Membership not found");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        input.teamId,
        managedRoleAction(membership.role),
      );
      if (membership.lifecycle !== "PENDING_KEY_GRANT")
        throw new Error("Membership is not pending key grants");
      const grantCount = await transaction.grantObject.count({
        where: { membershipId: input.membershipId },
      });
      if (grantCount !== input.requiredGrantCount)
        throw new Error("required Membership grant set is incomplete");

      const now = input.now ?? new Date();
      await this.stagedObjects.promote(transaction, {
        operationId: operation.operation.id,
        actorDeviceId: input.operation.actorDeviceId,
        now,
        objects: [
          {
            objectId: input.activationObject.id,
            canonicalBytes: input.activationObject.canonicalBytes,
            digest: input.activationObject.digest,
          },
        ],
      });
      const protocolObject = await new ProtocolObjectRepository().create(
        transaction,
        input.activationObject,
      );
      const activated = await transaction.membership.update({
        where: { id: input.membershipId },
        data: { lifecycle: "ACTIVE", activatedAt: now },
      });
      await transaction.membershipActivationObject.create({
        data: {
          protocolObjectId: protocolObject.id,
          membershipId: membership.id,
          teamId: input.teamId,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "MEMBERSHIP_ACTIVATED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "MEMBERSHIP",
        entityId: membership.id,
        priorLifecycle: "PENDING_KEY_GRANT",
        newLifecycle: "ACTIVE",
        outcomeObjectId: protocolObject.id,
      });
      return { operation: operation.operation, membership: activated };
    });
  }
}

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
  readonly now?: Date;
}>;

export class DeviceRepository {
  private readonly operations = new OperationRepository();
  private readonly protocolObjects = new ProtocolObjectRepository();
  private readonly audit = new AuditFactRepository();
  private readonly stagedObjects = new StagedObjectRepository();

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

export type RecoveryEnvelopeReplacementInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly envelope: Readonly<{
    readonly id: string;
    readonly protocolObject: ProtocolObjectInput;
    readonly identityGeneration: bigint;
    readonly recoveryGeneration: bigint;
    readonly ciphertextHash: Uint8Array;
    readonly ciphertextLength: number;
  }>;
  readonly now?: Date;
}>;

export class RecoveryRepository {
  private readonly operations = new OperationRepository();
  private readonly protocolObjects = new ProtocolObjectRepository();
  private readonly audit = new AuditFactRepository();
  private readonly stagedObjects = new StagedObjectRepository();

  async recordAttempt(
    database: TransactionDatabase,
    input: Readonly<{
      readonly userId: string;
      readonly deviceId?: string;
      readonly envelopeId?: string;
      readonly challengeHash: Uint8Array;
      readonly succeeded: boolean;
    }>,
  ) {
    return inShortTransaction(database, (transaction) =>
      transaction.recoveryAttempt.create({
        data: {
          userId: input.userId,
          challengeHash: databaseBytes(
            validateDigest(input.challengeHash, "challenge hash"),
          ),
          succeeded: input.succeeded,
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
          ...(input.envelopeId ? { envelopeId: input.envelopeId } : {}),
        },
      }),
    );
  }

  async replaceEnvelope(
    database: TransactionDatabase,
    input: RecoveryEnvelopeReplacementInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${input.operation.actorUserId} FOR UPDATE`;
      const user = await transaction.user.findUnique({
        where: { id: input.operation.actorUserId },
      });
      if (!user) throw new Error("User not found");
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
      if (input.envelope.identityGeneration !== user.identityGeneration)
        throw new Error("recovery envelope identity generation is stale");
      if (input.envelope.recoveryGeneration !== user.recoveryGeneration + 1n)
        throw new Error("recovery generation must advance by one");
      const now = input.now ?? new Date();
      await this.stagedObjects.promote(transaction, {
        operationId: operation.operation.id,
        actorDeviceId: input.operation.actorDeviceId,
        now,
        objects: [
          {
            objectId: input.envelope.protocolObject.id,
            canonicalBytes: input.envelope.protocolObject.canonicalBytes,
            digest: input.envelope.protocolObject.digest,
          },
        ],
      });
      const protocolObject = await this.protocolObjects.create(
        transaction,
        input.envelope.protocolObject,
      );
      await transaction.recoveryEnvelope.updateMany({
        where: { userId: input.operation.actorUserId, retiredAt: null },
        data: { retiredAt: now },
      });
      const envelope = await transaction.recoveryEnvelope.create({
        data: {
          id: input.envelope.id,
          userId: input.operation.actorUserId,
          protocolObjectId: protocolObject.id,
          identityGeneration: input.envelope.identityGeneration,
          recoveryGeneration: input.envelope.recoveryGeneration,
          ciphertextHash: databaseBytes(
            validateDigest(
              input.envelope.ciphertextHash,
              "recovery ciphertext hash",
            ),
          ),
          ciphertextLength: input.envelope.ciphertextLength,
        },
      });
      await transaction.user.update({
        where: { id: input.operation.actorUserId },
        data: { recoveryGeneration: input.envelope.recoveryGeneration },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "RECOVERY_COMPLETED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "RECOVERY_ENVELOPE",
        entityId: envelope.id,
        outcomeObjectId: protocolObject.id,
      });
      return { operation: operation.operation, envelope };
    });
  }
}

export type EpochRotationInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly projectId: string;
  readonly expectedEpoch: bigint;
  readonly newEpoch: bigint;
  readonly transitions: ReadonlyArray<
    Readonly<{
      readonly environmentId: string;
      readonly expectedHeadId: string;
      readonly newHeadId: string;
      readonly protocolObject: ProtocolObjectInput;
      readonly publication: RevisionPublicationInput;
    }>
  >;
  readonly now?: Date;
}>;

export class ProjectEpochRepository {
  private readonly operations = new OperationRepository();
  private readonly protocolObjects = new ProtocolObjectRepository();
  private readonly audit = new AuditFactRepository();
  private readonly publication = new PublicationRepository();
  private readonly stagedObjects = new StagedObjectRepository();

  async rotate(database: TransactionDatabase, input: EpochRotationInput) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const project = await transaction.project.findUnique({
        where: { id: input.projectId },
      });
      if (!project) throw new Error("Project not found");
      await requireTeamAction(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
        project.teamId,
        "ADMINISTER_PROJECT",
      );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      if (project.currentEpoch !== input.expectedEpoch)
        throw new StaleEpochError(project.currentEpoch);
      if (input.newEpoch !== input.expectedEpoch + 1n)
        throw new Error("Project epoch must advance by one");
      const transitions = [...input.transitions].sort((left, right) =>
        left.environmentId.localeCompare(right.environmentId),
      );
      for (const transition of transitions)
        await transaction.$executeRaw`SELECT "id" FROM "environments" WHERE "id" = ${transition.environmentId} AND "projectId" = ${input.projectId} FOR UPDATE`;
      const environments = await transaction.environment.findMany({
        where: { projectId: input.projectId, lifecycle: "ACTIVE" },
        select: { id: true, currentHeadId: true },
        orderBy: { id: "asc" },
      });
      if (
        environments.length !== transitions.length ||
        environments.some(
          (environment, index) =>
            environment.id !== transitions[index]?.environmentId ||
            environment.currentHeadId !== transitions[index]?.expectedHeadId,
        )
      )
        throw new StaleHeadError(null);
      const now = input.now ?? new Date();
      for (const transition of transitions) {
        if (
          transition.protocolObject.kind !== 12 ||
          transition.publication.operation.actorUserId !==
            input.operation.actorUserId ||
          transition.publication.operation.actorDeviceId !==
            input.operation.actorDeviceId ||
          transition.publication.environmentId !== transition.environmentId ||
          transition.publication.expectedHeadId !== transition.expectedHeadId ||
          transition.publication.revision.mutation !== "EPOCH_TRANSITION" ||
          transition.publication.revision.id !== transition.newHeadId ||
          transition.publication.revision.projectEpoch !== input.newEpoch
        )
          throw new Error("Project epoch transition publication is incomplete");
        await this.stagedObjects.promote(transaction, {
          operationId: operation.operation.id,
          actorDeviceId: input.operation.actorDeviceId,
          now,
          objects: [
            {
              objectId: transition.protocolObject.id,
              canonicalBytes: transition.protocolObject.canonicalBytes,
              digest: transition.protocolObject.digest,
            },
          ],
        });
        await this.publication.publishRevisionInTransaction(
          transaction,
          transition.publication,
        );
        const protocolObject = await this.protocolObjects.create(
          transaction,
          transition.protocolObject,
        );
        await transaction.epochTransitionObject.create({
          data: {
            protocolObjectId: protocolObject.id,
            projectId: input.projectId,
            previousEpoch: input.expectedEpoch,
            newEpoch: input.newEpoch,
            expectedHeadId: transition.expectedHeadId,
            newHeadId: transition.newHeadId,
          },
        });
        await transaction.environment.update({
          where: { id: transition.environmentId },
          data: { currentHeadId: transition.newHeadId },
        });
      }
      await transaction.project.update({
        where: { id: input.projectId },
        data: { currentEpoch: input.newEpoch },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "EPOCH_ROTATED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "PROJECT",
        entityId: input.projectId,
        newLifecycle: `epoch:${input.newEpoch.toString()}`,
      });
      return { operation: operation.operation, projectEpoch: input.newEpoch };
    });
  }
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
