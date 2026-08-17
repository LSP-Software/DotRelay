import { describe, expect, test } from "bun:test";
import { inShortTransaction } from "./transaction";

describe("short persistence transactions", () => {
  test("always applies bounded wait and timeout settings", async () => {
    let options: unknown;
    const database = {
      $transaction: async (
        callback: (transaction: { marker: string }) => Promise<string>,
        receivedOptions: unknown,
      ) => {
        options = receivedOptions;
        return callback({ marker: "transaction" });
      },
    };

    const result = await inShortTransaction(
      database as never,
      async () => "transaction",
    );

    expect(result).toBe("transaction");
    expect(options).toEqual({ maxWait: 5_000, timeout: 10_000 });
  });
});
