import { readFileSync, statSync } from "node:fs";

// Resolve only known secret files. Never log values or underlying IO errors.
for (const name of [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_SECRET",
]) {
  const path = process.env[`${name}_FILE`];
  if (!path) continue;
  if (process.env[name])
    throw new Error(`${name} and ${name}_FILE are mutually exclusive`);
  try {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error();
    process.env[name] = readFileSync(path, "utf8").trimEnd();
  } catch {
    throw new Error(`${name}_FILE must be a readable private regular file`);
  }
}
for (const name of [
  "DATABASE_URL",
  "SERVER_PROFILE_ID",
  "SERVER_PROFILE_ORIGIN",
  "WEB_ORIGIN",
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
]) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);
}
if (!process.env.GITHUB_CLIENT_ID?.startsWith("Iv"))
  throw new Error(
    "GITHUB_CLIENT_ID must identify a GitHub App, not a classic OAuth App",
  );
let database: URL;
try {
  database = new URL(process.env.DATABASE_URL!);
} catch {
  throw new Error("DATABASE_URL must identify a PostgreSQL database");
}
if (
  !["postgres:", "postgresql:"].includes(database.protocol) ||
  !database.hostname ||
  database.pathname === "/"
)
  throw new Error("DATABASE_URL must identify a PostgreSQL database");
// Run the real entry module so its import.meta.main startup path is preserved.
const child = Bun.spawn([process.execPath, "apps/api/dist/index.js"], {
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
