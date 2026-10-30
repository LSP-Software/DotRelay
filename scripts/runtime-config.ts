import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { loadServerProfileConfig } from "../apps/api/src/profile";

export const loadProductionEnvironment = (
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const environment = { ...source };
  if (environment.NODE_ENV !== "production")
    throw new Error("API image requires production mode");

  // Resolve only known secret files. Never log values or underlying IO errors.
  for (const name of [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "GITHUB_CLIENT_SECRET",
  ]) {
    const path = environment[`${name}_FILE`];
    if (!path) continue;
    if (environment[name])
      throw new Error(`${name} and ${name}_FILE are mutually exclusive`);
    try {
      const fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error();
        environment[name] = readFileSync(fd, "utf8").trimEnd();
      } finally {
        closeSync(fd);
      }
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
    if (!environment[name]?.trim()) throw new Error(`${name} is required`);
  }
  if (!environment.GITHUB_CLIENT_ID?.startsWith("Iv"))
    throw new Error(
      "GITHUB_CLIENT_ID must identify a GitHub App, not a classic OAuth App",
    );
  let database: URL;
  try {
    database = new URL(environment.DATABASE_URL!);
  } catch {
    throw new Error("DATABASE_URL must identify a PostgreSQL database");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !database.hostname ||
    database.pathname === "/"
  )
    throw new Error("DATABASE_URL must identify a PostgreSQL database");

  loadServerProfileConfig(environment);
  return environment;
};
