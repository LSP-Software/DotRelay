import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Build the self-contained Argon2id worker IIFE into public/argon2-worker.js.
//
// The client's runArgon2id spawns a Worker from
// globalThis.__DOTRELAY_ARGON2_WORKER_SOURCE__ when a host (this app) assigns
// the IIFE source; without it the password KDF runs on the main thread. The
// worker entrypoint imports only noble's argon2id, so the IIFE embeds the KDF
// with no other module graph (same pattern as scripts/client-browser.test.ts).
// The file is fetched at app init and its source handed to the client.
const root = join(import.meta.dir, "..");
const outDir = join(root, "public");
await mkdir(outDir, { recursive: true });
const build = await Bun.build({
  entrypoints: [
    join(
      root,
      "..",
      "..",
      "packages",
      "client",
      "src",
      "account",
      "argon2-worker.ts",
    ),
  ],
  format: "iife",
  outdir: outDir,
  target: "browser",
});
if (!build.success) {
  console.error("argon2 worker build failed:");
  for (const log of build.logs) console.error(log.message);
  process.exit(1);
}
const source = await readFile(join(outDir, "argon2-worker.js"), "utf8");
// Sanity: the KDF must be inside the bundle; without it the browser would
// silently lose the off-main-thread path.
if (!source.includes("onmessage"))
  throw new Error("argon2 worker bundle is missing the message handler");
console.log(`built public/argon2-worker.js (${source.length} bytes)`);
