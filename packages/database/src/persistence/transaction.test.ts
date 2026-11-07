import { describe, expect, test } from "bun:test";
import { OperationRepository, StagedObjectRepository } from "./objects";
import {
  inShortTransaction,
  runExpiryBatches,
  type TransactionDatabase,
} from "./transaction";

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

describe("batched expiry", () => {
  test("loops until a batch comes back short", async () => {
    const remaining = [3, 3, 1];
    const sizes: number[] = [];
    const total = await runExpiryBatches(
      async (batchSize) => {
        sizes.push(batchSize);
        const scanned = remaining.shift() ?? 0;
        return { scanned, affected: scanned };
      },
      { batchSize: 3 },
    );
    expect(total).toBe(7);
    expect(sizes).toEqual([3, 3, 3]);
  });

  test("stops starting batches once the time budget is spent", async () => {
    let time = 0;
    let calls = 0;
    const total = await runExpiryBatches(
      async (batchSize) => {
        calls += 1;
        time += 600;
        return { scanned: batchSize, affected: batchSize };
      },
      { batchSize: 10, timeBudgetMs: 1_000, clock: () => time },
    );
    expect(calls).toBe(2);
    expect(total).toBe(20);
  });

  test("rejects an invalid batch size", async () => {
    await expect(
      runExpiryBatches(async () => ({ scanned: 0, affected: 0 }), {
        batchSize: 0,
      }),
    ).rejects.toThrow("batch size");
  });

  test("deletes expired uncommitted staged rows in limited batches", async () => {
    const remaining = [2, 2, 1];
    const statements: string[] = [];
    const limits: unknown[] = [];
    const transaction = {
      $executeRaw: async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        statements.push(strings.join("?"));
        limits.push(values[1]);
        return remaining.shift() ?? 0;
      },
    };
    let transactions = 0;
    const database = {
      $transaction: async (
        callback: (value: typeof transaction) => Promise<number>,
      ) => {
        transactions += 1;
        return callback(transaction);
      },
    };

    const result = await new StagedObjectRepository().expire(
      database as never,
      new Date(),
      { batchSize: 2 },
    );

    expect(result).toEqual({ count: 5 });
    expect(transactions).toBe(3);
    expect(limits).toEqual([2, 2, 2]);
    expect(statements[0]).toContain('"committedAt" IS NULL');
    expect(statements[0]).toContain("LIMIT");
  });

  test("expires staging operations one batch per transaction", async () => {
    const batches = [
      [{ id: "a", actorUserId: "u", actorDeviceId: null }],
      [{ id: "b", actorUserId: "u", actorDeviceId: null }],
      [],
    ];
    const takes: unknown[] = [];
    const transaction = {
      operation: {
        findMany: async ({ take }: { take: number }) => {
          takes.push(take);
          return batches.shift() ?? [];
        },
        updateMany: async () => ({ count: 1 }),
      },
      stagedObject: { deleteMany: async () => ({ count: 0 }) },
      auditEvent: { create: async () => undefined },
    };
    const database = {
      $transaction: async (
        callback: (value: typeof transaction) => Promise<unknown>,
      ) => callback(transaction),
    };

    const result = await new OperationRepository().expireStaging(
      database as never,
      new Date(),
      { batchSize: 1 },
    );

    expect(result).toBe(2);
    expect(takes).toEqual([1, 1, 1]);
  });
});
