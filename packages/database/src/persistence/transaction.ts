import type { Prisma, PrismaClient } from "../generated/prisma/client";

export const DEFAULT_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 10_000,
});

export type TransactionDatabase = Pick<PrismaClient, "$transaction">;
export type TransactionAwareDatabase = PrismaClient | Prisma.TransactionClient;

const TRANSACTION_SCOPE_CONTEXT = Symbol.for(
  "prisma.client.transaction.scope_context",
);

export const inShortTransaction = async <T>(
  database: TransactionDatabase,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  return database.$transaction(callback, { ...DEFAULT_TRANSACTION_OPTIONS });
};

export const inShortTransactionUnlessActive = async <T>(
  database: TransactionAwareDatabase,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  if (TRANSACTION_SCOPE_CONTEXT in database)
    return callback(database as Prisma.TransactionClient);
  return inShortTransaction(database, callback);
};
