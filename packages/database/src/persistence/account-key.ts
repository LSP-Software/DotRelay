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
import { validateDigest } from "./validation";
export type AccountKeyWrapperInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly wrapper: Readonly<{
    readonly protocolObject: ProtocolObjectInput;
    readonly identityGeneration: bigint;
    readonly wrapperType: "PASSKEY_PRF" | "PASSWORD" | "RECOVERY_CODE";
    readonly wrapperId: Uint8Array;
    readonly credentialId?: Uint8Array;
    readonly kdfName?: number;
    readonly kdfMemoryKib?: bigint;
    readonly kdfIterations?: bigint;
    readonly kdfParallelism?: number;
    readonly ciphertextHash: Uint8Array;
    readonly ciphertextLength: number;
  }>;
  readonly now?: Date;
}>;

export type AccountKeyEnvelopeInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly envelope: Readonly<{
    readonly protocolObject: ProtocolObjectInput;
    readonly identityGeneration: bigint;
    readonly envelopeType: "PROJECT_EPOCH_KEY" | "USER_VALUE_KEY";
    readonly projectId?: string;
    readonly projectEpoch?: bigint;
    readonly ownerUserId?: string;
    readonly valueGeneration?: bigint;
    readonly ciphertextHash: Uint8Array;
    readonly ciphertextLength: number;
  }>;
  readonly now?: Date;
}>;

export type AccountKeyTransferInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly transfer: Readonly<{
    readonly protocolObject: ProtocolObjectInput;
    readonly identityGeneration: bigint;
    readonly recipientDeviceId: string;
    readonly transferId: Uint8Array;
    readonly expiresAt: Date;
  }>;
  readonly now?: Date;
}>;

export class AccountKeyRepository {
  private readonly operations = new OperationRepository();
  private readonly protocolObjects = new ProtocolObjectRepository();
  private readonly audit = new AuditFactRepository();
  private readonly stagedObjects = new StagedObjectRepository();

  async addWrapper(
    database: TransactionDatabase,
    input: AccountKeyWrapperInput,
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
      if (input.wrapper.identityGeneration !== user.identityGeneration)
        throw new Error("account key wrapper identity generation is stale");
      if (
        input.wrapper.wrapperType === "PASSKEY_PRF" &&
        !input.wrapper.credentialId
      )
        throw new Error("passkey wrapper requires a credential id");
      if (
        input.wrapper.wrapperType === "PASSWORD" &&
        input.wrapper.kdfName === undefined
      )
        throw new Error("password wrapper requires a KDF name");
      if (input.wrapper.wrapperType === "RECOVERY_CODE") {
        if (input.wrapper.credentialId || input.wrapper.kdfName !== undefined)
          throw new Error("recovery code wrapper carries foreign metadata");
      }
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      await this.stagedObjects.promote(transaction, {
        operationId: operation.operation.id,
        actorDeviceId: input.operation.actorDeviceId,
        now,
        objects: [
          {
            objectId: input.wrapper.protocolObject.id,
            canonicalBytes: input.wrapper.protocolObject.canonicalBytes,
            digest: input.wrapper.protocolObject.digest,
          },
        ],
      });
      const protocolObject = await this.protocolObjects.create(
        transaction,
        input.wrapper.protocolObject,
      );
      if (input.wrapper.wrapperType === "RECOVERY_CODE") {
        // Rotating the Recovery Code retires only the previously active
        // RECOVERY_CODE wrapper; other wrapper types are optional and keep
        // coexisting (ADR 0009).
        await transaction.accountKeyWrapperObject.updateMany({
          where: {
            userId: input.operation.actorUserId,
            retiredAt: null,
            wrapperType: "RECOVERY_CODE",
          },
          data: { retiredAt: now },
        });
      }
      const wrapper = await transaction.accountKeyWrapperObject.create({
        data: {
          protocolObjectId: protocolObject.id,
          userId: input.operation.actorUserId,
          identityGeneration: input.wrapper.identityGeneration,
          wrapperType: input.wrapper.wrapperType,
          wrapperId: databaseBytes(input.wrapper.wrapperId),
          ...(input.wrapper.credentialId
            ? { credentialId: databaseBytes(input.wrapper.credentialId) }
            : {}),
          ...(input.wrapper.kdfName !== undefined
            ? { kdfName: input.wrapper.kdfName }
            : {}),
          ...(input.wrapper.kdfMemoryKib !== undefined
            ? { kdfMemoryKib: input.wrapper.kdfMemoryKib }
            : {}),
          ...(input.wrapper.kdfIterations !== undefined
            ? { kdfIterations: input.wrapper.kdfIterations }
            : {}),
          ...(input.wrapper.kdfParallelism !== undefined
            ? { kdfParallelism: input.wrapper.kdfParallelism }
            : {}),
          ciphertextHash: databaseBytes(
            validateDigest(
              input.wrapper.ciphertextHash,
              "wrapper ciphertext hash",
            ),
          ),
          ciphertextLength: input.wrapper.ciphertextLength,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "ACCOUNT_KEY_WRAPPER_ADDED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "ACCOUNT_KEY_WRAPPER",
        entityId: wrapper.protocolObjectId,
        outcomeObjectId: protocolObject.id,
      });
      return { operation: operation.operation, wrapper };
    });
  }

  async revokeWrapper(
    database: TransactionDatabase,
    input: Readonly<{
      readonly operation: OperationInput & { readonly actorDeviceId: string };
      readonly wrapperId: Uint8Array;
      readonly now?: Date;
    }>,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${input.operation.actorUserId} FOR UPDATE`;
      await requireActiveDevice(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
      );
      const wrapper = await transaction.accountKeyWrapperObject.findFirst({
        where: {
          userId: input.operation.actorUserId,
          wrapperId: databaseBytes(input.wrapperId),
          retiredAt: null,
        },
      });
      if (!wrapper)
        throw new Error("account key wrapper is not active for this user");
      const activeCount = await transaction.accountKeyWrapperObject.count({
        where: { userId: input.operation.actorUserId, retiredAt: null },
      });
      if (wrapper.wrapperType === "RECOVERY_CODE") {
        // A RECOVERY_CODE wrapper is the universal disaster-recovery route,
        // so at least one must always survive (ADR 0009).
        const activeRecoveryCodeCount =
          await transaction.accountKeyWrapperObject.count({
            where: {
              userId: input.operation.actorUserId,
              retiredAt: null,
              wrapperType: "RECOVERY_CODE",
            },
          });
        if (activeRecoveryCodeCount <= 1)
          throw new Error(
            "the last active RECOVERY_CODE wrapper cannot be revoked",
          );
      }
      if (activeCount <= 1)
        throw new Error("the last account key wrapper cannot be revoked");
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      await transaction.accountKeyWrapperObject.update({
        where: { protocolObjectId: wrapper.protocolObjectId },
        data: { retiredAt: now },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "ACCOUNT_KEY_WRAPPER_REVOKED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "ACCOUNT_KEY_WRAPPER",
        entityId: wrapper.protocolObjectId,
      });
      return { operation: operation.operation, wrapper };
    });
  }

  async publishEnvelope(
    database: TransactionDatabase,
    input: AccountKeyEnvelopeInput,
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
      if (input.envelope.identityGeneration !== user.identityGeneration)
        throw new Error("account key envelope identity generation is stale");
      if (input.envelope.envelopeType === "PROJECT_EPOCH_KEY") {
        if (
          !input.envelope.projectId ||
          input.envelope.projectEpoch === undefined
        )
          throw new Error(
            "project epoch envelope requires a project and epoch",
          );
        if (
          input.envelope.ownerUserId ||
          input.envelope.valueGeneration !== undefined
        )
          throw new Error("project epoch envelope carries user value fields");
        const project = await transaction.project.findFirst({
          where: {
            id: input.envelope.projectId,
            lifecycle: "ACTIVE",
            team: {
              memberships: {
                some: {
                  userId: input.operation.actorUserId,
                  lifecycle: "ACTIVE",
                },
              },
            },
          },
        });
        if (!project)
          throw new Error("envelope project is not reachable by the user");
        if (input.envelope.projectEpoch < 1n)
          throw new Error("project epoch envelope requires a positive epoch");
        // Prior epochs remain re-publishable so recovering Devices can read
        // pre-rotation data; future epochs never exist yet.
        if (input.envelope.projectEpoch > project.currentEpoch)
          throw new Error(
            "project epoch envelope must not target a future epoch",
          );
      } else {
        if (
          !input.envelope.ownerUserId ||
          input.envelope.valueGeneration === undefined
        )
          throw new Error(
            "user value envelope requires an owner and generation",
          );
        if (
          input.envelope.projectId ||
          input.envelope.projectEpoch !== undefined
        )
          throw new Error("user value envelope carries project fields");
        if (input.envelope.ownerUserId !== input.operation.actorUserId)
          throw new Error("user value envelope must belong to the acting user");
      }
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
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
      const envelope = await transaction.accountKeyEnvelopeObject.create({
        data: {
          protocolObjectId: protocolObject.id,
          userId: input.operation.actorUserId,
          envelopeType: input.envelope.envelopeType,
          ...(input.envelope.projectId
            ? { projectId: input.envelope.projectId }
            : {}),
          ...(input.envelope.projectEpoch !== undefined
            ? { projectEpoch: input.envelope.projectEpoch }
            : {}),
          ...(input.envelope.ownerUserId
            ? { ownerUserId: input.envelope.ownerUserId }
            : {}),
          ...(input.envelope.valueGeneration !== undefined
            ? { valueGeneration: input.envelope.valueGeneration }
            : {}),
          ciphertextHash: databaseBytes(
            validateDigest(
              input.envelope.ciphertextHash,
              "envelope ciphertext hash",
            ),
          ),
          ciphertextLength: input.envelope.ciphertextLength,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "ACCOUNT_KEY_ENVELOPE_PUBLISHED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "ACCOUNT_KEY_ENVELOPE",
        entityId: envelope.protocolObjectId,
        outcomeObjectId: protocolObject.id,
      });
      return { operation: operation.operation, envelope };
    });
  }

  async createTransfer(
    database: TransactionDatabase,
    input: AccountKeyTransferInput,
  ) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${input.operation.actorUserId} FOR UPDATE`;
      await requireActiveDevice(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
      );
      const recipient = await transaction.device.findFirst({
        where: {
          id: input.transfer.recipientDeviceId,
          userId: input.operation.actorUserId,
          lifecycle: "ACTIVE",
        },
      });
      if (!recipient)
        throw new Error("transfer recipient device is not active");
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      await this.stagedObjects.promote(transaction, {
        operationId: operation.operation.id,
        actorDeviceId: input.operation.actorDeviceId,
        now,
        objects: [
          {
            objectId: input.transfer.protocolObject.id,
            canonicalBytes: input.transfer.protocolObject.canonicalBytes,
            digest: input.transfer.protocolObject.digest,
          },
        ],
      });
      const protocolObject = await this.protocolObjects.create(
        transaction,
        input.transfer.protocolObject,
      );
      const transfer = await transaction.accountKeyTransferObject.create({
        data: {
          protocolObjectId: protocolObject.id,
          userId: input.operation.actorUserId,
          recipientDeviceId: recipient.id,
          transferId: databaseBytes(input.transfer.transferId),
          status: "PENDING",
          expiresAt: input.transfer.expiresAt,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "ACCOUNT_KEY_TRANSFER_CREATED",
        actorUserId: input.operation.actorUserId,
        ...(input.operation.actorDeviceId
          ? { actorDeviceId: input.operation.actorDeviceId }
          : {}),
        entityKind: "ACCOUNT_KEY_TRANSFER",
        entityId: transfer.protocolObjectId,
        outcomeObjectId: protocolObject.id,
      });
      return { operation: operation.operation, transfer };
    });
  }

  async acceptTransfer(
    database: TransactionDatabase,
    input: Readonly<{
      readonly userId: string;
      readonly deviceId: string;
      readonly transferId: Uint8Array;
      readonly now?: Date;
    }>,
  ) {
    const now = input.now ?? new Date();
    const pending = await inShortTransaction(database, async (transaction) => {
      return transaction.accountKeyTransferObject.findFirst({
        where: {
          userId: input.userId,
          recipientDeviceId: input.deviceId,
          transferId: databaseBytes(input.transferId),
          status: "PENDING",
        },
        select: {
          protocolObjectId: true,
          expiresAt: true,
          protocolObject: { select: { canonicalBytes: true } },
        },
      });
    });
    if (!pending) throw new Error("account key transfer is not pending");
    if (pending.expiresAt <= now) {
      // The EXPIRED status must survive the rollback that the throw below
      // would otherwise trigger, so it commits in its own transaction.
      const marked = await inShortTransaction(database, async (transaction) => {
        return transaction.accountKeyTransferObject.updateMany({
          where: {
            protocolObjectId: pending.protocolObjectId,
            status: "PENDING",
          },
          data: { status: "EXPIRED" },
        });
      });
      if (marked.count === 0)
        throw new Error("account key transfer is not pending");
      throw new Error("account key transfer expired");
    }
    const accepted = await inShortTransaction(database, async (transaction) => {
      // updateMany (rather than update) keeps a lost consume race from
      // raising P2025 inside the transaction, which poisons the pooled
      // connection for later top-level calls.
      const marked = await transaction.accountKeyTransferObject.updateMany({
        where: {
          protocolObjectId: pending.protocolObjectId,
          status: "PENDING",
        },
        data: { status: "CONSUMED", consumedAt: now },
      });
      if (marked.count === 0) return null;
      const row = await transaction.accountKeyTransferObject.findUniqueOrThrow({
        where: { protocolObjectId: pending.protocolObjectId },
        select: { protocolObjectId: true, consumedAt: true },
      });
      return Object.freeze({
        protocolObjectId: row.protocolObjectId,
        consumedAt: row.consumedAt,
        canonicalBytes: new Uint8Array(pending.protocolObject.canonicalBytes),
      });
    });
    if (!accepted) throw new Error("account key transfer is not pending");
    return accepted;
  }
}
