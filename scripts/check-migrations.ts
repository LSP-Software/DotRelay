import { join } from "node:path";
import { run } from "./run-command";

const root = process.cwd();
const schema = join(root, "apps/api/prisma/schema.prisma");
const migrations = join(root, "apps/api/prisma/migrations");
await run(
  [
    "bun",
    "x",
    "prisma",
    "migrate",
    "diff",
    "--config",
    join(root, "apps/api/prisma.config.ts"),
    "--from-empty",
    "--to-schema",
    schema,
    "--script",
    "--exit-code",
  ],
  root,
);
await run(
  [
    "bun",
    "x",
    "prisma",
    "migrate",
    "diff",
    "--config",
    join(root, "apps/api/prisma.config.ts"),
    "--from-config-datasource",
    "--to-schema",
    schema,
    "--script",
    "--exit-code",
  ],
  root,
);
await run(
  [
    "bun",
    "x",
    "prisma",
    "migrate",
    "diff",
    "--config",
    join(root, "apps/api/prisma.config.ts"),
    "--from-migrations",
    migrations,
    "--to-schema",
    schema,
    "--script",
    "--exit-code",
  ],
  root,
);
console.log("✓ Prisma migration history can be compared with the schema");
