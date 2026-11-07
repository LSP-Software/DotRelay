import { readFileSync } from "node:fs";
import { join } from "node:path";

// `bun lint` is only a built-in on the pinned canary. On other builds it resolves to the
// package's own `lint` script and recurses, so refuse to run instead of passing silently.
const toolchainPath = join(import.meta.dir, "..", "ops", "bun-toolchain.json");
const { commit } = JSON.parse(readFileSync(toolchainPath, "utf8")) as {
  commit: string;
};

if (Bun.revision !== commit) {
  console.error(
    `bun lint needs the pinned canary Bun (${commit}); this is Bun ${Bun.version} (${Bun.revision}). ` +
      "Run python3 scripts/setup-bun.py",
  );
  process.exit(1);
}

const proc = Bun.spawn([process.execPath, "lint", ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
