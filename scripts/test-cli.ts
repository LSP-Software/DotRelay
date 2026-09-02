import { access, constants, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageCliPackage } from "./stage-cli-package";

const root = join(import.meta.dir, "..");
const binary = join(
  root,
  "apps",
  "cli",
  "dist",
  process.platform === "win32" ? "dotrelay.exe" : "dotrelay",
);
type Completed = Readonly<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}>;

const run = async (
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Completed> => {
  const child = Bun.spawn([binary, ...args], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const expectSuccess = (result: Completed, description: string): string => {
  if (result.exitCode !== 0)
    throw new Error(`${description} failed: ${result.stderr}`);
  return result.stdout.trim();
};

await access(binary, process.platform === "win32" ? undefined : constants.X_OK);
const help = await run(["--help"]);
if (
  help.exitCode !== 0 ||
  !help.stdout.includes("dotrelay — DotRelay standalone CLI")
)
  throw new Error("packaged CLI help contract failed");
const version = expectSuccess(await run(["--version"]), "packaged CLI version");
if (version !== "0.0.0-foundation")
  throw new Error(`unexpected CLI version: ${version}`);

const isolatedDirectory = await mkdtemp(
  join(tmpdir(), "dotrelay-cli-contract-"),
);
try {
  const refused = await run(
    [
      "init",
      "66666666-6666-4666-8666-666666666666",
      "--profile",
      "missing",
      "--environment",
      "66666666-6666-4666-8666-666666666666",
      "--from",
      "postgres://black-box-secret",
      "--no-input",
    ],
    { ...process.env, DOTRELAY_CONFIG_DIR: isolatedDirectory },
  );
  if (refused.exitCode === 0 || refused.stderr.includes("black-box-secret"))
    throw new Error(
      `protected workflow refusal contract failed: ${refused.stderr}`,
    );
  const forbidden = await run(["pull", "--token", "secret"]);
  if (forbidden.exitCode !== 2 || forbidden.stderr.includes("secret"))
    throw new Error("credential flag refusal contract failed");
  console.log(
    "✓ packaged protected-workflow refusal and secret-safety checks passed",
  );
} finally {
  await rm(isolatedDirectory, { recursive: true, force: true });
}

await stageCliPackage();
const packageDirectory = join(root, "packages", "dotrelay");
const distDirectory = join(packageDirectory, "dist");
const manifest = (await Bun.file(
  join(packageDirectory, "package.json"),
).json()) as { readonly files?: readonly string[] };
if (!manifest.files?.includes("dist"))
  throw new Error("npm selector package must publish its dist directory");
const selector = join(packageDirectory, "bin", "dotrelay.mjs");
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
if (selectorExitCode !== 0 || selectorOutput.trim() !== version)
  throw new Error(`npm selector contract failed: ${selectorError}`);
const expectedBinary =
  process.platform === "win32" ? "dotrelay.exe" : "dotrelay";
const currentPlatformDirectory = `${process.platform}-${process.arch}`;
await access(join(distDirectory, currentPlatformDirectory, expectedBinary));
console.log("✓ npm selector and current-platform artifact checks passed");
