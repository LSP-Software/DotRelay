import { access, constants, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const packageDirectory = join(root, "packages", "dotrelay");
const distDirectory = join(packageDirectory, "dist");
const platformDirectories = await readdir(distDirectory, {
  withFileTypes: true,
});
const binaries = platformDirectories.filter((entry) => entry.isDirectory());
const platforms = new Set(
  binaries.map((entry) => entry.name.slice(0, entry.name.indexOf("-"))),
);
const missingPlatforms = ["linux", "darwin", "win32"].filter(
  (platform) => !platforms.has(platform),
);
if (missingPlatforms.length > 0) {
  const message = `the npm selector package is missing ${missingPlatforms.join(", ")} native artifact(s)`;
  if (process.env.CI === "true") throw new Error(message);
  console.warn(`⚠ ${message}; local artifact-only run`);
}
for (const directory of binaries) {
  const binary = join(
    distDirectory,
    directory.name,
    directory.name.startsWith("win32-") ? "dotrelay.exe" : "dotrelay",
  );
  await access(
    binary,
    directory.name.startsWith("win32-") ? undefined : constants.X_OK,
  );
}

const selector = join(packageDirectory, "bin", "dotrelay.mjs");
const child = Bun.spawn([process.execPath, selector, "--version"], {
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
if (exitCode !== 0 || stdout.trim().length === 0)
  throw new Error(`npm selector package smoke test failed: ${stderr}`);
console.log("✓ npm selector package artifacts and selector run passed");
