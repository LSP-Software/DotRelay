import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://dotrelay:dotrelay@127.0.0.1:5432/dotrelay",
    shadowDatabaseUrl:
      process.env.SHADOW_DATABASE_URL ??
      "postgresql://dotrelay:dotrelay@127.0.0.1:5432/dotrelay_shadow",
  },
});
