import { join } from "node:path";

const binary = join(
  import.meta.dir,
  "..",
  "apps",
  "cli",
  "dist",
  process.platform === "win32" ? "dotrelay.exe" : "dotrelay",
);
async function run(args: string[]): Promise<string> {
  const process = Bun.spawn([binary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`CLI exited with ${exitCode}: ${stderr}`);
  return stdout.trim();
}

const help = await run(["--help"]);
if (!help.includes("dotrelay — DotRelay standalone CLI"))
  throw new Error("CLI help smoke test failed");
const version = await run(["--version"]);
if (version !== "0.0.0-foundation")
  throw new Error(`unexpected CLI version: ${version}`);
console.log("✓ packaged CLI round trip passed");
