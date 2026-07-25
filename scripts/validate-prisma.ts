import { join } from "node:path";
import { run } from "./run-command";

const root = process.cwd();
await run(
  [
    "bun",
    "x",
    "prisma",
    "validate",
    "--config",
    join(root, "apps/api/prisma.config.ts"),
  ],
  root,
);
