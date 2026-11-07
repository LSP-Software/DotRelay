import type { Prisma, PrismaClient } from "../generated/prisma/client";

export const DEFAULT_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 10_000,
});

export type TransactionDatabase = Pick<PrismaClient, "$transaction">;

export const inShortTransaction = async <T>(
  database: TransactionDatabase,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  return database.$transaction(callback, { ...DEFAULT_TRANSACTION_OPTIONS });
};

export type ExpiryBatchOptions = Readonly<{
  /** Rows handled per short transaction. */
  readonly batchSize?: number;
  /** No new batch starts once this much time has passed. */
  readonly timeBudgetMs?: number;
  readonly clock?: () => number;
}>;

export const DEFAULT_EXPIRY_BATCH_SIZE = 500;
export const DEFAULT_EXPIRY_TIME_BUDGET_MS = 30_000;

/**
 * Runs `runBatch` repeatedly, one short transaction per call, until a batch
 * scans fewer rows than the batch size or the time budget is spent. Returns
 * the total number of rows affected. Work left over when the budget runs out
 * is picked up by the next scheduled run.
 */
export const runExpiryBatches = async (
  runBatch: (
    batchSize: number,
  ) => Promise<Readonly<{ scanned: number; affected: number }>>,
  options?: ExpiryBatchOptions,
): Promise<number> => {
  const batchSize = options?.batchSize ?? DEFAULT_EXPIRY_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw new Error("expiry batch size is invalid");
  const clock = options?.clock ?? Date.now;
  const deadline =
    clock() + (options?.timeBudgetMs ?? DEFAULT_EXPIRY_TIME_BUDGET_MS);
  let total = 0;
  for (;;) {
    const { scanned, affected } = await runBatch(batchSize);
    total += affected;
    if (scanned < batchSize || clock() >= deadline) return total;
  }
};
