import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `bun lint` is only a built-in on the pinned canary, which is kept for this
// one purpose: everything else builds, tests and ships on the stable runtime
// in ops/bun-toolchain.json. scripts/setup-bun.py installs the canary beside
// it and CI exports its path as DOTRELAY_LINT_BUN. On a build without the
// built-in, `bun lint` resolves to the package's own `lint` script and
// recurses, so refuse to run instead of passing silently.
const toolchainPath = join(import.meta.dir, "..", "ops", "bun-toolchain.json");
const { lint } = JSON.parse(readFileSync(toolchainPath, "utf8")) as {
  lint: { commit: string; revision: string };
};

const binaryName = process.platform === "win32" ? "bun.exe" : "bun";
const candidates = [
  process.env.DOTRELAY_LINT_BUN,
  ...[process.env.RUNNER_TEMP, tmpdir()]
    .filter((directory): directory is string => Boolean(directory))
    .map((directory) =>
      join(directory, `dotrelay-bun-${lint.commit}`, binaryName),
    ),
  Bun.revision === lint.commit ? process.execPath : undefined,
].filter((path): path is string => Boolean(path) && existsSync(path as string));

const revisionOf = (path: string): string => {
  const result = Bun.spawnSync([path, "--revision"]);
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
};

const linter = candidates.find((path) => revisionOf(path) === lint.revision);
if (!linter) {
  console.error(
    `bun lint needs the pinned lint-only canary Bun (${lint.revision}). Run python3 scripts/setup-bun.py, or set DOTRELAY_LINT_BUN to that binary.`,
  );
  process.exit(1);
}

const proc = Bun.spawn([linter, "lint", ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
