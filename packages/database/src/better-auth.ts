import { prismaAdapter } from "@better-auth/prisma-adapter";
import type { PrismaClient } from "./generated/prisma/client";

export const createBetterAuthDatabaseAdapter = (database: PrismaClient) =>
  prismaAdapter(database, {
    provider: "postgresql",
    transaction: true,
  });

export type BetterAuthDatabaseAdapter = ReturnType<
  typeof createBetterAuthDatabaseAdapter
>;
