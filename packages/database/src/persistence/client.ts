import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const DEVELOPMENT_CONNECTION_STRING =
  "postgresql://dotrelay:dotrelay@127.0.0.1:5432/dotrelay";

const resolveConnectionString = () => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.NODE_ENV === "production")
    throw new Error("DATABASE_URL is required in production");
  return DEVELOPMENT_CONNECTION_STRING;
};

export const createDatabaseClient = (
  connectionString = resolveConnectionString(),
) => {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
};

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;
