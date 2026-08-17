import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

export const createDatabaseClient = (
  connectionString = process.env.DATABASE_URL ??
    "postgresql://dotrelay:dotrelay@127.0.0.1:5432/dotrelay",
) => {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
};
