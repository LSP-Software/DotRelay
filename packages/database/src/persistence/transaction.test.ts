import { describe, expect, test } from "bun:test";
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
});
