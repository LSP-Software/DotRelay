import { join } from "node:path";
import { stageCliPackage } from "./stage-cli-package";

const binary = join(
  import.meta.dir,
  "..",
  "apps",
  "cli",
  "dist",
  process.platform === "win32" ? "dotrelay.exe" : "dotrelay",
);
const run = async (args: string[]): Promise<string> => {
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
};

const help = await run(["--help"]);
if (!help.includes("dotrelay — DotRelay standalone CLI"))
  throw new Error("CLI help smoke test failed");
const version = await run(["--version"]);
if (version !== "0.0.0-foundation")
  throw new Error(`unexpected CLI version: ${version}`);
console.log("✓ packaged CLI round trip passed");

await stageCliPackage();
const selector = join(
  import.meta.dir,
  "..",
  "packages",
  "dotrelay",
  "bin",
  "dotrelay.mjs",
);
const selectorProcess = Bun.spawn([process.execPath, selector, "--version"], {
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "DOTRELAY_BINARY"),
  ),
  stdout: "pipe",
  stderr: "pipe",
});
const [selectorOutput, selectorError, selectorExitCode] = await Promise.all([
  new Response(selectorProcess.stdout).text(),
  new Response(selectorProcess.stderr).text(),
  selectorProcess.exited,
]);
if (selectorExitCode !== 0)
  throw new Error(
    `npm selector exited with ${selectorExitCode}: ${selectorError}`,
  );
if (selectorOutput.trim() !== version)
  throw new Error(`unexpected npm selector version: ${selectorOutput.trim()}`);
console.log("✓ npm selector forwarded the command contract");
