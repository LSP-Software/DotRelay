import { describe, expect, test } from "bun:test";
import {
  inShortTransaction,
  inShortTransactionUnlessActive,
  type TransactionAwareDatabase,
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

  test("reuses an active Prisma transaction", async () => {
    const transaction = {
      [Symbol.for("prisma.client.transaction.scope_context")]: {
        kind: "nested",
      },
      $transaction: () => {
        throw new Error("must not start a nested transaction");
      },
    };

    const result = await inShortTransactionUnlessActive(
      transaction as unknown as TransactionAwareDatabase,
      async () => "active transaction",
    );

    expect(result).toBe("active transaction");
  });
});
