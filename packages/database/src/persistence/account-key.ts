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

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
};

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
  // establish: no active wrapper yet. A second candidate loses and must not
  // retire the winner. rotate: replace the active recovery code. add: attach
  // a passkey or password beside an established account. Omitted keeps the
  // historical recovery-code retire behaviour.
  readonly intent?: "establish" | "rotate" | "add";
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
      const activeWrapperCount =
        await transaction.accountKeyWrapperObject.count({
          where: { userId: input.operation.actorUserId, retiredAt: null },
        });
      if (input.intent === "establish") {
        if (activeWrapperCount > 0)
          throw new Error("account key is already established");
      } else if (input.intent === "add") {
        if (input.wrapper.wrapperType === "RECOVERY_CODE")
          throw new Error("account key recovery code cannot be added");
        if (activeWrapperCount < 1)
          throw new Error("account key is not established");
      } else if (input.intent === "rotate") {
        if (input.wrapper.wrapperType !== "RECOVERY_CODE")
          throw new Error("account key rotation requires a recovery code");
        const activeRecoveryCount =
          await transaction.accountKeyWrapperObject.count({
            where: {
              userId: input.operation.actorUserId,
              retiredAt: null,
              wrapperType: "RECOVERY_CODE",
            },
          });
        if (activeRecoveryCount < 1)
          throw new Error("account key recovery code is missing");
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
      if (
        input.wrapper.wrapperType === "RECOVERY_CODE" &&
        input.intent !== "establish"
      ) {
        // Rotating the Recovery Code retires only the previously active
        // RECOVERY_CODE wrapper; other wrapper types are optional and keep
        // coexisting (ADR 0009). First establishment does not retire anything:
        // a losing candidate must leave the winner in place.
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
      const existingEnvelope = await (async () => {
        if (input.envelope.envelopeType === "PROJECT_EPOCH_KEY") {
          const projectId = input.envelope.projectId;
          const projectEpoch = input.envelope.projectEpoch;
          if (projectId === undefined || projectEpoch === undefined)
            throw new Error(
              "project epoch envelope requires a project and epoch",
            );
          return transaction.accountKeyEnvelopeObject.findFirst({
            where: {
              userId: input.operation.actorUserId,
              retiredAt: null,
              envelopeType: "PROJECT_EPOCH_KEY",
              projectId,
              projectEpoch,
            },
          });
        }
        const ownerUserId = input.envelope.ownerUserId;
        const valueGeneration = input.envelope.valueGeneration;
        if (ownerUserId === undefined || valueGeneration === undefined)
          throw new Error(
            "user value envelope requires an owner and generation",
          );
        return transaction.accountKeyEnvelopeObject.findFirst({
          where: {
            userId: input.operation.actorUserId,
            retiredAt: null,
            envelopeType: "USER_VALUE_KEY",
            ownerUserId,
            valueGeneration,
          },
        });
      })();
      if (existingEnvelope) {
        const existingHash = new Uint8Array(existingEnvelope.ciphertextHash);
        const identical =
          existingEnvelope.ciphertextLength ===
            input.envelope.ciphertextLength &&
          sameBytes(existingHash, input.envelope.ciphertextHash);
        if (!identical)
          throw new Error("account key envelope conflicts with the active key");
      }
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return operation;
      const now = input.now ?? new Date();
      if (existingEnvelope) {
        await transaction.operation.update({
          where: { id: operation.operation.id },
          data: { status: "COMMITTED", committedAt: now },
        });
        return {
          operation: operation.operation,
          envelope: existingEnvelope,
          idempotent: true as const,
        };
      }
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
    const loaded = await inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
      const device = await transaction.device.findFirst({
        where: { id: input.deviceId, userId: input.userId },
        select: { lifecycle: true },
      });
      if (!device) throw new Error("account key transfer is not pending");
      if (device.lifecycle !== "ACTIVE")
        throw new Error("account key transfer recipient is revoked");
      return transaction.accountKeyTransferObject.findFirst({
        where: {
          userId: input.userId,
          recipientDeviceId: input.deviceId,
          transferId: databaseBytes(input.transferId),
        },
        select: {
          protocolObjectId: true,
          status: true,
          expiresAt: true,
          protocolObject: { select: { canonicalBytes: true } },
        },
      });
    });
    if (!loaded || loaded.status === "CONSUMED" || loaded.status === "EXPIRED")
      throw new Error("account key transfer is not pending");
    if (loaded.expiresAt <= now) {
      // The EXPIRED status must survive the rollback that the throw below
      // would otherwise trigger, so it commits in its own transaction.
      const marked = await inShortTransaction(database, async (transaction) => {
        return transaction.accountKeyTransferObject.updateMany({
          where: {
            protocolObjectId: loaded.protocolObjectId,
            status: { in: ["PENDING", "DELIVERED"] },
          },
          data: { status: "EXPIRED" },
        });
      });
      if (marked.count === 0)
        throw new Error("account key transfer is not pending");
      throw new Error("account key transfer expired");
    }
    const accepted = await inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
      const device = await transaction.device.findFirst({
        where: { id: input.deviceId, userId: input.userId },
        select: { lifecycle: true },
      });
      if (device?.lifecycle !== "ACTIVE") return null;
      const row = await transaction.accountKeyTransferObject.findFirst({
        where: {
          protocolObjectId: loaded.protocolObjectId,
          recipientDeviceId: input.deviceId,
          status: { in: ["PENDING", "DELIVERED"] },
        },
        select: {
          protocolObjectId: true,
          status: true,
          expiresAt: true,
          protocolObject: { select: { canonicalBytes: true } },
        },
      });
      if (!row || row.expiresAt <= now) return null;
      if (row.status === "PENDING") {
        // Delivery is not consumption. A lost response stays retryable until
        // the recipient acknowledges the transfer or it expires.
        const marked = await transaction.accountKeyTransferObject.updateMany({
          where: {
            protocolObjectId: row.protocolObjectId,
            status: "PENDING",
          },
          data: { status: "DELIVERED" },
        });
        if (marked.count === 0) return null;
      }
      return Object.freeze({
        protocolObjectId: row.protocolObjectId,
        canonicalBytes: new Uint8Array(row.protocolObject.canonicalBytes),
      });
    });
    if (!accepted) throw new Error("account key transfer is not pending");
    return accepted;
  }

  async acknowledgeTransfer(
    database: TransactionDatabase,
    input: Readonly<{
      readonly userId: string;
      readonly deviceId: string;
      readonly transferId: Uint8Array;
      readonly now?: Date;
    }>,
  ) {
    const now = input.now ?? new Date();
    const loaded = await inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
      const device = await transaction.device.findFirst({
        where: { id: input.deviceId, userId: input.userId },
        select: { lifecycle: true },
      });
      if (!device) throw new Error("account key transfer is not pending");
      if (device.lifecycle !== "ACTIVE")
        throw new Error("account key transfer recipient is revoked");
      return transaction.accountKeyTransferObject.findFirst({
        where: {
          userId: input.userId,
          recipientDeviceId: input.deviceId,
          transferId: databaseBytes(input.transferId),
        },
        select: {
          protocolObjectId: true,
          status: true,
          expiresAt: true,
        },
      });
    });
    if (!loaded) throw new Error("account key transfer is not pending");
    if (loaded.status === "CONSUMED")
      return Object.freeze({
        protocolObjectId: loaded.protocolObjectId,
        idempotent: true,
      });
    if (loaded.status === "EXPIRED" || loaded.expiresAt <= now) {
      if (loaded.status === "PENDING" || loaded.status === "DELIVERED") {
        const marked = await inShortTransaction(
          database,
          async (transaction) => {
            return transaction.accountKeyTransferObject.updateMany({
              where: {
                protocolObjectId: loaded.protocolObjectId,
                status: { in: ["PENDING", "DELIVERED"] },
              },
              data: { status: "EXPIRED" },
            });
          },
        );
        if (marked.count === 0)
          throw new Error("account key transfer is not pending");
      }
      throw new Error("account key transfer expired");
    }
    if (loaded.status !== "DELIVERED")
      throw new Error("account key transfer is not delivered");
    const acknowledged = await inShortTransaction(
      database,
      async (transaction) => {
        await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
        const device = await transaction.device.findFirst({
          where: {
            id: input.deviceId,
            userId: input.userId,
            lifecycle: "ACTIVE",
          },
          select: { id: true },
        });
        if (!device) return "revoked" as const;
        const marked = await transaction.accountKeyTransferObject.updateMany({
          where: {
            protocolObjectId: loaded.protocolObjectId,
            status: "DELIVERED",
            recipientDeviceId: input.deviceId,
          },
          data: { status: "CONSUMED", consumedAt: now },
        });
        if (marked.count === 1)
          return Object.freeze({
            protocolObjectId: loaded.protocolObjectId,
            idempotent: false,
          });
        const current = await transaction.accountKeyTransferObject.findUnique({
          where: { protocolObjectId: loaded.protocolObjectId },
          select: { status: true, recipientDeviceId: true },
        });
        if (
          current?.status === "CONSUMED" &&
          current.recipientDeviceId === input.deviceId
        )
          return Object.freeze({
            protocolObjectId: loaded.protocolObjectId,
            idempotent: true,
          });
        return null;
      },
    );
    if (acknowledged === "revoked")
      throw new Error("account key transfer recipient is revoked");
    if (!acknowledged) throw new Error("account key transfer is not delivered");
    return acknowledged;
  }
}
