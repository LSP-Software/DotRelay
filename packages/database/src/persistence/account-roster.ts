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
  type PersistenceClient,
  requireActiveDevice,
} from "./repository-core";
import { inShortTransaction, type TransactionDatabase } from "./transaction";

export type AccountRosterInput = Readonly<{
  readonly operation: OperationInput & { readonly actorDeviceId: string };
  readonly roster: Readonly<{
    readonly protocolObject: ProtocolObjectInput;
    readonly version: bigint;
    /** Raw 32-byte Ed25519 account identity the roster names. */
    readonly accountIdentity: Uint8Array;
  }>;
  readonly now?: Date;
}>;

export class AccountRosterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountRosterConflictError";
  }
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

// Stores Account Device rosters (ADR 0015). Version 1 comes from any active
// Device of the User; later versions must be exactly latest + 1 and name the
// identity of version 1. These checks keep an honest service consistent;
// clients verify every roster against the identity they pinned or derived.
export class AccountRosterRepository {
  private readonly operations = new OperationRepository();
  private readonly protocolObjects = new ProtocolObjectRepository();
  private readonly stagedObjects = new StagedObjectRepository();
  private readonly audit = new AuditFactRepository();

  async publish(database: TransactionDatabase, input: AccountRosterInput) {
    return inShortTransaction(database, async (transaction) => {
      await transaction.$executeRaw`SELECT "id" FROM "users" WHERE "id" = ${input.operation.actorUserId} FOR UPDATE`;
      await requireActiveDevice(
        transaction,
        input.operation.actorUserId,
        input.operation.actorDeviceId,
      );
      if (
        input.roster.protocolObject.kind !== 24 ||
        input.roster.version < 1n ||
        input.roster.accountIdentity.length !== 32
      )
        throw new Error("account device roster is invalid");
      const existing = await transaction.accountDeviceRosterObject.findUnique({
        where: {
          userId_version: {
            userId: input.operation.actorUserId,
            version: input.roster.version,
          },
        },
        select: {
          protocolObjectId: true,
          protocolObject: { select: { digest: true } },
        },
      });
      if (
        existing &&
        !sameBytes(
          new Uint8Array(existing.protocolObject.digest),
          input.roster.protocolObject.digest,
        )
      )
        throw new AccountRosterConflictError(
          "a different roster already holds this version",
        );
      const operation = await this.operations.begin(
        transaction,
        input.operation,
      );
      if (operation.idempotent) return { ...operation, idempotent: true };
      const now = input.now ?? new Date();
      if (existing) {
        await transaction.operation.update({
          where: { id: operation.operation.id },
          data: { status: "COMMITTED", committedAt: now },
        });
        return { operation: operation.operation, idempotent: true as const };
      }
      const [first, latest] = await Promise.all([
        transaction.accountDeviceRosterObject.findFirst({
          where: { userId: input.operation.actorUserId },
          orderBy: { version: "asc" },
          select: { accountIdentity: true },
        }),
        transaction.accountDeviceRosterObject.findFirst({
          where: { userId: input.operation.actorUserId },
          orderBy: { version: "desc" },
          select: { version: true },
        }),
      ]);
      const expectedVersion = latest ? latest.version + 1n : 1n;
      if (input.roster.version !== expectedVersion)
        throw new AccountRosterConflictError(
          "account device roster version must advance by one",
        );
      if (
        first &&
        !sameBytes(
          new Uint8Array(first.accountIdentity),
          input.roster.accountIdentity,
        )
      )
        throw new AccountRosterConflictError(
          "account device roster names another account identity",
        );
      await this.stagedObjects.promote(transaction, {
        operationId: operation.operation.id,
        actorDeviceId: input.operation.actorDeviceId,
        now,
        objects: [
          {
            objectId: input.roster.protocolObject.id,
            canonicalBytes: input.roster.protocolObject.canonicalBytes,
            digest: input.roster.protocolObject.digest,
          },
        ],
      });
      const protocolObject = await this.protocolObjects.create(
        transaction,
        input.roster.protocolObject,
      );
      await transaction.accountDeviceRosterObject.create({
        data: {
          protocolObjectId: protocolObject.id,
          userId: input.operation.actorUserId,
          version: input.roster.version,
          accountIdentity: databaseBytes(input.roster.accountIdentity),
          operationId: operation.operation.id,
        },
      });
      await transaction.operation.update({
        where: { id: operation.operation.id },
        data: { status: "COMMITTED", committedAt: now },
      });
      await this.audit.append(transaction, {
        operationId: operation.operation.id,
        kind: "ACCOUNT_DEVICE_ROSTER_PUBLISHED",
        actorUserId: input.operation.actorUserId,
        actorDeviceId: input.operation.actorDeviceId,
        entityKind: "USER",
        entityId: input.operation.actorUserId,
        outcomeObjectId: protocolObject.id,
      });
      return { operation: operation.operation, idempotent: false as const };
    });
  }

  /** The latest roster bytes for each User; null for a User without one. */
  async latestFor(
    database: PersistenceClient,
    userIds: readonly string[],
  ): Promise<Map<string, Uint8Array | null>> {
    const unique = [...new Set(userIds)];
    const rows = unique.length
      ? await database.accountDeviceRosterObject.findMany({
          where: { userId: { in: unique } },
          orderBy: { version: "desc" },
          distinct: ["userId"],
          select: {
            userId: true,
            protocolObject: { select: { canonicalBytes: true } },
          },
        })
      : [];
    const latest = new Map<string, Uint8Array | null>(
      unique.map((userId) => [userId, null]),
    );
    for (const row of rows)
      latest.set(row.userId, new Uint8Array(row.protocolObject.canonicalBytes));
    return latest;
  }
}
