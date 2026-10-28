import {
  AuditFactRepository,
  type OperationInput,
  OperationRepository,
  type ProtocolObjectInput,
  ProtocolObjectRepository,
  StagedObjectRepository,
} from "./objects";
import {
  databaseBytes,
  requireActiveDevice,
  sameBytes,
} from "./repository-core";
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
  readonly device: Readonly<{
    readonly id: string;
    readonly identityGeneration: bigint;
    readonly keyId: Uint8Array;
    readonly x25519PublicKey: Uint8Array;
    readonly ed25519PublicKey: Uint8Array;
  }>;
  readonly client?: DeviceClientMetadata | null;
  readonly now?: Date;
}>;

export type DeviceEnrollmentApprovalInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly enrollmentId: string;
  readonly approvalObject: ProtocolObjectInput;
  readonly certificateObject: ProtocolObjectInput;
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
  readonly enrollmentObject: ProtocolObjectInput;
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

  // The initiator is the prospective Device: not yet ACTIVE, and possibly not
  // yet a row at all. Its row is created here as PENDING so the enrollment
  // can reference it; an approval is what promotes it to ACTIVE.
  async beginEnrollment(
    database: TransactionDatabase,
    input: DeviceEnrollmentBeginInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      const existing = await transaction.device.findUnique({
        where: { id: input.device.id },
      });
      if (existing && existing.userId !== input.userId)
        throw new Error(
          "a device with this id already belongs to another user",
        );
      if (existing) {
        const keyId = databaseBytes(
          validateDigest(input.device.keyId, "Device key id"),
        );
        if (!sameBytes(existing.keyId, keyId))
          throw new Error("device key id conflicts with the stored device");
        if (existing.lifecycle === "REVOKED")
          await transaction.device.update({
            where: { id: input.device.id },
            data: {
              lifecycle: "PENDING",
              activatedAt: null,
              revokedAt: null,
            },
          });
      } else {
        const now = input.now ?? new Date();
        await transaction.device.create({
          data: {
            id: input.device.id,
            userId: input.userId,
            lifecycle: "PENDING",
            identityGeneration: input.device.identityGeneration,
            keyId: databaseBytes(
              validateDigest(input.device.keyId, "Device key id"),
            ),
            x25519PublicKey: databaseBytes(input.device.x25519PublicKey),
            ed25519PublicKey: databaseBytes(input.device.ed25519PublicKey),
            createdAt: now,
            ...clientCreateData(input.client),
          },
        });
      }
      const operation = await this.operations.begin(transaction, {
        ...input.operation,
        kind: "DEVICE_ENROLLMENT",
      });
      if (operation.idempotent) return operation;
      if (input.userId !== input.operation.actorUserId)
        throw new Error("enrollment user must match the actor user");
      if (input.initiatorDeviceId !== input.operation.actorDeviceId)
        throw new Error("enrollment initiator must match the actor device");
      if (input.device.id !== input.initiatorDeviceId)
        throw new Error("enrollment device must match the initiator");
      const existingAfterOperation = await transaction.device.findUnique({
        where: { id: input.device.id },
      });
      if (existingAfterOperation?.lifecycle === "ACTIVE")
        throw new Error("device is already active");
      const user = await transaction.user.findUnique({
        where: { id: input.userId },
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
      // Enrollment needs an existing ACTIVE Device to approve the request;
      // a User with none must use initial trust bootstrap instead.
      const activeDeviceCount = await transaction.device.count({
        where: { userId: input.userId, lifecycle: "ACTIVE" },
      });
      if (activeDeviceCount === 0)
        throw new Error(
          "the user has no active device to approve an enrollment; use initial trust bootstrap for the first device",
        );
      const now = input.now ?? new Date();
      if (input.expiresAt <= now) throw new Error("Device enrollment expired");
      // The Device's certificate (and its protocol object) are recorded when
      // an approval activates the Device: device_certificate_objects is
      // append-only, so a PENDING row could never be promoted to ACTIVE.
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

  // The approver is an existing ACTIVE Device of the User. Approval is what
  // activates the prospective Device: one existing Device approving the
  // prospective Device's self-signed request is enough, which is how a User
  // with a single Device adds a second one.
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
      const prospective = await transaction.device.findUnique({
        where: { id: enrollment.initiatorDeviceId },
      });
      // Once an approval activated the prospective Device, further approvals
      // of the same enrollment are stale.
      if (
        !prospective ||
        prospective.userId !== enrollment.userId ||
        prospective.lifecycle !== "PENDING"
      )
        throw new Error("Device enrollment is not pending");
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
          {
            objectId: input.certificateObject.id,
            canonicalBytes: input.certificateObject.canonicalBytes,
            digest: input.certificateObject.digest,
          },
        ],
      });
      const approvalObject = await this.protocolObjects.create(
        transaction,
        input.approvalObject,
      );
      const certificateObject = await this.protocolObjects.create(
        transaction,
        input.certificateObject,
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
      await transaction.device.update({
        where: { id: prospective.id },
        data: { lifecycle: "ACTIVE", activatedAt: now },
      });
      // device_certificate_objects is append-only, so the prospective
      // Device's certificate is recorded here, when the Device activates,
      // rather than at begin.
      await transaction.deviceCertificateObject.create({
        data: {
          protocolObjectId: certificateObject.id,
          deviceId: prospective.id,
          userId: prospective.userId,
          identityGeneration: prospective.identityGeneration,
          lifecycle: "ACTIVE",
        },
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
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "DEVICE_ENROLLED",
        actorUserId: input.operation.actorUserId,
        actorDeviceId: input.operation.actorDeviceId,
        entityKind: "DEVICE",
        entityId: prospective.id,
        newLifecycle: "ACTIVE",
        outcomeObjectId: certificateObject.id,
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
      // Bootstrap is first-Device-only: once the User has an ACTIVE Device,
      // additional Devices join through dual-control enrollment (whose
      // beginEnrollment gate requires at least one ACTIVE Device). The count
      // runs under the User row lock above, after the idempotent-replay
      // early return, so a retry of a committed bootstrap still returns
      // idempotent instead of being rejected.
      const activeDeviceCount = await transaction.device.count({
        where: { userId: input.operation.actorUserId, lifecycle: "ACTIVE" },
      });
      if (activeDeviceCount > 0)
        throw new Error(
          "a device has already been bootstrapped; use enrollment to add another device",
        );
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

  // Completion is the prospective Device's own confirmation, made after an
  // approval already activated it. The Device row (and its certificate) was
  // recorded at begin/approval time; this records the self-signed request
  // object and closes the enrollment.
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
      if (enrollment.initiatorDeviceId !== input.operation.actorDeviceId)
        throw new Error(
          "enrollment completion must come from the initiator device",
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
        ],
      });
      const enrollmentObject = await this.protocolObjects.create(
        transaction,
        input.enrollmentObject,
      );
      await transaction.enrollmentObject.create({
        data: {
          protocolObjectId: enrollmentObject.id,
          enrollmentId: enrollment.id,
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
      return { operation: operation.operation, enrollment };
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
      if (!device || device.userId !== input.operation.actorUserId)
        throw new Error("Device not found");
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
      // A retry under a new Idempotency-Key must not sign the User out again
      // for a Device that is already gone; replaying the original operation
      // id above still returns the recorded outcome.
      if (device.lifecycle === "REVOKED")
        throw new Error("Device is not active");
      const now = input.now ?? new Date();
      const revoked = await transaction.device.update({
        where: { id: device.id },
        data: { lifecycle: "REVOKED", revokedAt: now },
      });
      // Sessions are not bound to Devices. A stolen session could otherwise
      // bootstrap a replacement Device immediately after revocation.
      const user = await transaction.user.findUniqueOrThrow({
        where: { id: input.operation.actorUserId },
        select: { authSubject: true },
      });
      await transaction.authSession.deleteMany({
        where: { userId: user.authSubject },
      });
      await transaction.authDeviceCode.deleteMany({
        where: { userId: user.authSubject },
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
