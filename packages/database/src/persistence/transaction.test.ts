import { describe, expect, test } from "bun:test";
import { OperationRepository } from "./repositories";
import { inShortTransaction, type TransactionDatabase } from "./transaction";

describe("short persistence transactions", () => {
  test("always applies bounded wait and timeout settings", async () => {
    let options: unknown;
    const database = {
      $transaction: async (
        callback: (transaction: { marker: string }) => Promise<string>,
        receivedOptions: unknown,
      ) => {
        options = { ...(receivedOptions as Record<string, unknown>) };
        Object.defineProperty(receivedOptions, "newTxId", {
          value: "nested-transaction",
        });
        return callback({ marker: "transaction" });
      },
    };

    const result = await inShortTransaction(
      database as unknown as TransactionDatabase,
      async () => "transaction",
    );

    expect(result).toBe("transaction");
    expect(options).toEqual({ maxWait: 5_000, timeout: 10_000 });
  });

  test("records expiry facts only for operations transitioned to expired", async () => {
    const expiredOperations = [
      {
        id: "expired-operation",
        actorUserId: "expired-user",
        actorDeviceId: "expired-device",
      },
      {
        id: "cancelled-operation",
        actorUserId: "cancelled-user",
        actorDeviceId: null,
      },
    ];
    const updates: string[] = [];
    const audits: string[] = [];
    const transaction = {
      operation: {
        findMany: async () => expiredOperations,
        updateMany: async ({ where }: { where: { id: string } }) => {
          updates.push(where.id);
          return { count: where.id === "expired-operation" ? 1 : 0 };
        },
      },
      stagedObject: {
        deleteMany: async ({ where }: { where: { operationId: string } }) => {
          expect(where.operationId).toBe("expired-operation");
          return { count: 1 };
        },
      },
      auditEvent: {
        create: async ({ data }: { data: { operationId: string } }) => {
          audits.push(data.operationId);
        },
      },
    };
    const database = {
      $transaction: async (
        callback: (value: typeof transaction) => Promise<number>,
      ) => callback(transaction),
    };

    const result = await new OperationRepository().expireStaging(
      database as never,
      new Date(),
    );

    expect(result).toBe(1);
    expect(updates).toEqual(["expired-operation", "cancelled-operation"]);
    expect(audits).toEqual(["expired-operation"]);
  });
});
