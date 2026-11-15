import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLaunchableExecutable } from "../packages/dotrelay/bin/is-launchable-executable.mjs";
import {
  CLI_TARGETS,
  cliPlatformPackageName,
  cliTargetKey,
  SELECTOR_PACKAGE,
} from "./cli-targets";

const root = join(import.meta.dir, "..");
const packageDirectory = join(root, "packages", "dotrelay");

// Synthetic probes install the published selector code and manifest beside
// platform packages the probe controls, in the node_modules layout npm
// creates, so the packaged artifact's version and launch-failure contract is
// tested, not the source CLI.
const probeVersion = "9.9.9";
type ProbeBinary = Readonly<{
  readonly target: string;
  readonly file: string;
  readonly content: string;
  readonly mode?: number;
  readonly version?: string;
}>;

const selectorPath = (directory: string): string =>
  join(directory, "node_modules", "@dotrelay", "cli", "bin", "dotrelay.mjs");

const createProbePackage = async (
  probeBinaries: readonly ProbeBinary[],
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "dotrelay-selector-probe-"));
  const scope = join(directory, "node_modules", "@dotrelay");
  await mkdir(join(scope, "cli", "bin"), { recursive: true });
  // The selector and its launch check ship as a pair; the probe package
  // must mirror the published bin directory or the selector cannot load.
  for (const binFile of ["dotrelay.mjs", "is-launchable-executable.mjs"]) {
    await writeFile(
      join(scope, "cli", "bin", binFile),
      await readFile(join(packageDirectory, "bin", binFile), "utf8"),
    );
  }
  await writeFile(
    join(scope, "cli", "package.json"),
    `${JSON.stringify(
      {
        name: SELECTOR_PACKAGE,
        version: probeVersion,
        optionalDependencies: Object.fromEntries(
          CLI_TARGETS.map((target) => [
            cliPlatformPackageName(target),
            probeVersion,
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  for (const probeBinary of probeBinaries) {
    const platformPackage = join(scope, `cli-${probeBinary.target}`);
    await mkdir(join(platformPackage, "bin"), { recursive: true });
    await writeFile(
      join(platformPackage, "package.json"),
      `${JSON.stringify({
        name: `${SELECTOR_PACKAGE}-${probeBinary.target}`,
        version: probeBinary.version ?? probeVersion,
      })}\n`,
    );
    const target = join(platformPackage, "bin", probeBinary.file);
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

// Synthetic native executable headers pin the selector's format and
// architecture checks. The real regression this guards: modern macOS builds
// are little-endian Mach-O (on-disk magic 0xcffaedfe), which the selector
// must recognize as launchable instead of reporting as a foreign binary.
const writeU32 = (value: number, littleEndian: boolean): number[] =>
  littleEndian
    ? [
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]
    : [
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      ];

const MACH_CPU_TYPES: Record<string, number> = {
  x64: 0x01000007,
  ia32: 7,
  arm64: 0x0100000c,
  arm: 12,
};
// Mirrors the selector's table (ambiguous ppc64/s390x entries omitted for
// the same reason), keeping the probe an independent oracle of the check.
const ELF_MACHINES: Record<string, number> = {
  x64: 62,
  ia32: 3,
  arm64: 183,
  arm: 40,
  riscv64: 243,
  mips: 8,
  mipsel: 8,
};
const PE_MACHINES: Record<string, number> = {
  x64: 0x8664,
  ia32: 0x014c,
  arm64: 0xaa64,
  arm: 0x01c0,
};

const machHeader = (cpuType: number, littleEndian: boolean): Buffer =>
  Buffer.from([
    ...writeU32(0xfeedfacf, littleEndian),
    ...writeU32(cpuType, littleEndian),
    ...writeU32(0, littleEndian),
  ]);

const fatMachHeader = (littleEndian: boolean): Buffer =>
  Buffer.from([...writeU32(0xcafebabe, littleEndian), 0, 0, 0, 1]);

const elfHeader = (machine: number, littleEndian: boolean): Buffer => {
  const header = Buffer.alloc(64);
  header[0] = 0x7f;
  header[1] = 0x45;
  header[2] = 0x4c;
  header[3] = 0x46;
  header[5] = littleEndian ? 1 : 2;
  const low = machine & 0xff;
  const high = (machine >>> 8) & 0xff;
  header[18] = littleEndian ? low : high;
  header[19] = littleEndian ? high : low;
  return header;
};

const peHeader = (machine: number): Buffer => {
  const header = Buffer.alloc(128);
  header[0] = 0x4d;
  header[1] = 0x5a;
  header[0x3c] = 0x40;
  header[0x40] = 0x50;
  header[0x41] = 0x45;
  header[0x44] = machine & 0xff;
  header[0x45] = (machine >>> 8) & 0xff;
  return header;
};

const expectLaunchable = async (
  directory: string,
  name: string,
  content: Buffer | string,
  expected: boolean,
): Promise<void> => {
  const file = join(directory, name);
  await writeFile(file, content);
  if (process.platform !== "win32") await chmod(file, 0o755);
  const actual = await isLaunchableExecutable(file);
  if (actual !== expected)
    throw new Error(
      `selector format probe ${name}: expected launchable=${expected}, got ${actual}`,
    );
};

const runSelectorFormatProbes = async (directory: string): Promise<void> => {
  await expectLaunchable(directory, "shebang", "#!/bin/sh\nexit 0\n", true);
  await expectLaunchable(directory, "text", "not a native binary\n", false);
  await expectLaunchable(directory, "empty", Buffer.alloc(0), false);
  await expectLaunchable(
    directory,
    "truncated",
    Buffer.from([0x7f, 0x45]),
    false,
  );

  // Of the verified ELF architectures only mips is big-endian.
  const elfLittleEndian = process.arch !== "mips";
  const nativeElfMachine = ELF_MACHINES[process.arch];
  if (nativeElfMachine !== undefined) {
    await expectLaunchable(
      directory,
      "elf-native",
      elfHeader(nativeElfMachine, elfLittleEndian),
      true,
    );
    const foreignElfMachine = nativeElfMachine === 62 ? 183 : 62;
    await expectLaunchable(
      directory,
      "elf-foreign",
      elfHeader(foreignElfMachine, true),
      false,
    );
  }

  const nativeCpuType = MACH_CPU_TYPES[process.arch];
  if (nativeCpuType !== undefined) {
    const foreignCpuType =
      nativeCpuType === 0x0100000c ? 0x01000007 : 0x0100000c;
    await expectLaunchable(
      directory,
      "macho-little-native",
      machHeader(nativeCpuType, true),
      true,
    );
    await expectLaunchable(
      directory,
      "macho-little-foreign",
      machHeader(foreignCpuType, true),
      false,
    );
    await expectLaunchable(
      directory,
      "macho-big-native",
      machHeader(nativeCpuType, false),
      true,
    );
    await expectLaunchable(
      directory,
      "macho-big-foreign",
      machHeader(foreignCpuType, false),
      false,
    );
  }
  await expectLaunchable(
    directory,
    "macho-fat-little",
    fatMachHeader(true),
    true,
  );
  await expectLaunchable(
    directory,
    "macho-fat-big",
    fatMachHeader(false),
    true,
  );

  const nativePeMachine = PE_MACHINES[process.arch];
  if (process.platform === "win32" && nativePeMachine !== undefined) {
    const foreignPeMachine = nativePeMachine === 0x8664 ? 0xaa64 : 0x8664;
    await expectLaunchable(
      directory,
      "pe-native",
      peHeader(nativePeMachine),
      true,
    );
    await expectLaunchable(
      directory,
      "pe-foreign",
      peHeader(foreignPeMachine),
      false,
    );
  } else if (process.platform !== "win32") {
    // A PE executable is never launchable off Windows, whatever its header.
    await expectLaunchable(
      directory,
      "pe-other-platform",
      peHeader(0x8664),
      false,
    );
  }

  if (await isLaunchableExecutable(join(directory, "missing")))
    throw new Error(
      "selector format probe missing: absent file reported launchable",
    );
};

const runProbe = async (
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>> => {
  const probe = Bun.spawn(
    [process.execPath, selectorPath(directory), "--version"],
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

  const formatDirectory = await mkdtemp(
    join(tmpdir(), "dotrelay-selector-format-"),
  );
  try {
    await runSelectorFormatProbes(formatDirectory);
  } finally {
    await rm(formatDirectory, { recursive: true, force: true });
  }

  const supported = CLI_TARGETS.some(
    (target) => cliTargetKey(target) === platformDirectory,
  );
  const missingReport = supported
    ? `the @dotrelay/cli-${platformDirectory} package is missing`
    : `DotRelay does not publish a native binary for ${platformDirectory}`;
  const repairs = [
    `npm install -g @dotrelay/cli@${probeVersion}`,
    process.platform === "win32" ? "install.ps1" : "install.sh",
    "https://github.com/LSP-Software/DotRelay/releases",
  ];

  const missingProbe = await createProbePackage([
    {
      target: `${otherPlatform}-x64`,
      file: "dotrelay",
      content: "other-platform artifact\n",
    },
  ]);
  try {
    const result = await runProbe(missingProbe, probeEnvironment);
    expectFailure(result, "missing-platform selector probe", [
      `dotrelay ${probeVersion}`,
      missingReport,
      `${otherPlatform}-x64`,
      ...repairs,
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
      missingReport,
      ...repairs,
    ]);
  } finally {
    await rm(overrideProbe, { recursive: true, force: true });
  }

  // A platform package left over from another release must not run under
  // this selector's version.
  const mismatchProbe = await createProbePackage([
    {
      target: platformDirectory,
      file: platformBinary,
      content: "#!/bin/sh\necho stale-binary-ran\n",
      mode: 0o755,
      version: "9.9.8",
    },
  ]);
  try {
    const result = await runProbe(mismatchProbe, probeEnvironment);
    expectFailure(result, "mismatched platform package probe", [
      `dotrelay ${probeVersion}`,
      `@dotrelay/cli-${platformDirectory} is version 9.9.8, not ${probeVersion}`,
      `npm install -g @dotrelay/cli@${probeVersion}`,
    ]);
    if (result.stdout.includes("stale-binary-ran"))
      throw new Error("mismatched platform package probe ran the binary");
  } finally {
    await rm(mismatchProbe, { recursive: true, force: true });
  }

  if (process.platform === "win32") return;

  const notExecutableProbe = await createProbePackage([
    {
      target: platformDirectory,
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
      `npm install -g @dotrelay/cli@${probeVersion}`,
    ]);
  } finally {
    await rm(notExecutableProbe, { recursive: true, force: true });
  }

  // A file with no valid header or shebang passes the executable-bit probe
  // but cannot launch: this is the wrong-architecture and corrupted-binary
  // case, and the report must name the repair, not only the platform.
  const unlaunchableProbe = await createProbePackage([
    {
      target: platformDirectory,
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
      `npm install -g @dotrelay/cli@${probeVersion}`,
    ]);
  } finally {
    await rm(unlaunchableProbe, { recursive: true, force: true });
  }
};
