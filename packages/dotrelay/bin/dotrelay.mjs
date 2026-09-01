import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
);
const platformBinary =
  process.platform === "win32" ? "dotrelay.exe" : "dotrelay";
const platformDirectory = `${process.platform}-${process.arch}`;
const accessMode = process.platform === "win32" ? undefined : constants.X_OK;
const candidates = [
  process.env.DOTRELAY_BINARY,
  join(packageDirectory, "dist", platformDirectory, platformBinary),
  join(packageDirectory, "dist", platformBinary),
  join(packageDirectory, "..", "..", "apps", "cli", "dist", platformBinary),
].filter((candidate) => candidate !== undefined);

const binary = await candidates.reduce(async (found, candidate) => {
  const current = await found;
  if (current) return current;
  try {
    await access(candidate, accessMode);
    return candidate;
  } catch {
    return undefined;
  }
}, Promise.resolve(undefined));

if (!binary) {
  console.error(
    `dotrelay: no native binary is packaged for ${platformDirectory}`,
  );
  process.exitCode = 1;
} else {
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
  child.once("error", () => {
    console.error(
      `dotrelay: could not start native binary for ${platformDirectory}`,
    );
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
