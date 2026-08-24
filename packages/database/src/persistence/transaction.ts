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
