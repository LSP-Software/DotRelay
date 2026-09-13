import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const packageDirectory = join(root, "packages", "dotrelay");

// Synthetic probes copy the published selector code and manifest around a
// dist tree the probe controls, so the packaged artifact's version and
// launch-failure contract is tested, not the source CLI.
const probeVersion = "9.9.9";
type ProbeBinary = Readonly<{
  readonly directory: string;
  readonly file: string;
  readonly content: string;
  readonly mode?: number;
}>;

const createProbePackage = async (
  probeBinaries: readonly ProbeBinary[],
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "dotrelay-selector-probe-"));
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(
    join(directory, "bin", "dotrelay.mjs"),
    await readFile(join(packageDirectory, "bin", "dotrelay.mjs"), "utf8"),
  );
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "dotrelay", version: probeVersion }, null, 2)}\n`,
  );
  for (const probeBinary of probeBinaries) {
    const target = join(
      directory,
      "dist",
      probeBinary.directory,
      probeBinary.file,
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, probeBinary.content);
    if (process.platform !== "win32" && probeBinary.mode !== undefined)
      await chmod(target, probeBinary.mode);
  }
  return directory;
};

// The probes must not follow an ambient binary override.
const probeEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "DOTRELAY_BINARY"),
);

const runProbe = async (
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>> => {
  const probe = Bun.spawn(
    [process.execPath, join(directory, "bin", "dotrelay.mjs"), "--version"],
    { env: environment, stdout: "pipe", stderr: "pipe" },
  );
  const [probeStdout, probeStderr, probeExitCode] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ]);
  return { stdout: probeStdout, stderr: probeStderr, exitCode: probeExitCode };
};

const expectFailure = (
  result: Readonly<{ stdout: string; stderr: string; exitCode: number }>,
  description: string,
  fragments: readonly string[],
): void => {
  if (result.exitCode !== 1)
    throw new Error(
      `${description} failed with exit code ${result.exitCode}: ${result.stderr}`,
    );
  for (const fragment of fragments)
    if (!result.stderr.includes(fragment))
      throw new Error(`${description} omitted ${fragment}: ${result.stderr}`);
};

export const runCliPackageProbes = async (): Promise<void> => {
  const platformDirectory = `${process.platform}-${process.arch}`;
  const platformBinary =
    process.platform === "win32" ? "dotrelay.exe" : "dotrelay";
  const otherPlatform = process.platform === "linux" ? "darwin" : "linux";

  const missingProbe = await createProbePackage([
    {
      directory: `${otherPlatform}-x64`,
      file: "dotrelay",
      content: "other-platform artifact\n",
    },
  ]);
  try {
    const result = await runProbe(missingProbe, probeEnvironment);
    expectFailure(result, "missing-platform selector probe", [
      `dotrelay ${probeVersion}`,
      `no native binary is packaged for ${platformDirectory}`,
      `${otherPlatform}-x64`,
      "npm install -g dotrelay@",
    ]);
  } finally {
    await rm(missingProbe, { recursive: true, force: true });
  }

  const overrideProbe = await createProbePackage([]);
  try {
    const missingBinary = join(overrideProbe, "absent", "dotrelay");
    const result = await runProbe(overrideProbe, {
      ...probeEnvironment,
      DOTRELAY_BINARY: missingBinary,
    });
    expectFailure(result, "DOTRELAY_BINARY override probe", [
      `dotrelay ${probeVersion}`,
      "DOTRELAY_BINARY points at",
      missingBinary,
      `no native binary is packaged for ${platformDirectory}`,
      "npm install -g dotrelay@",
    ]);
  } finally {
    await rm(overrideProbe, { recursive: true, force: true });
  }

  if (process.platform === "win32") return;

  const notExecutableProbe = await createProbePackage([
    {
      directory: platformDirectory,
      file: platformBinary,
      content: "placeholder native binary\n",
      mode: 0o644,
    },
  ]);
  try {
    const result = await runProbe(notExecutableProbe, probeEnvironment);
    expectFailure(result, "not-executable selector probe", [
      `dotrelay ${probeVersion}`,
      "is not executable",
      "chmod +x",
      "npm install -g dotrelay@",
    ]);
  } finally {
    await rm(notExecutableProbe, { recursive: true, force: true });
  }

  // A file with no valid header or shebang passes the executable-bit probe
  // but cannot launch: this is the wrong-architecture and corrupted-binary
  // case, and the report must name the repair, not only the platform.
  const unlaunchableProbe = await createProbePackage([
    {
      directory: platformDirectory,
      file: platformBinary,
      content: "not a native binary for this machine\n",
      mode: 0o755,
    },
  ]);
  try {
    const result = await runProbe(unlaunchableProbe, probeEnvironment);
    expectFailure(result, "unlaunchable selector probe", [
      `dotrelay ${probeVersion}`,
      `could not start the native binary for ${platformDirectory}`,
      "npm install -g dotrelay@",
    ]);
  } finally {
    await rm(unlaunchableProbe, { recursive: true, force: true });
  }
};
