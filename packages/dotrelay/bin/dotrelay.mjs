#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, constants, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
);
const platformBinary =
  process.platform === "win32" ? "dotrelay.exe" : "dotrelay";
const platformDirectory = `${process.platform}-${process.arch}`;
const executableMode =
  process.platform === "win32" ? undefined : constants.X_OK;

// Diagnostics identify the release being run so a failed launch names the
// installation instead of only the platform that failed.
let selectorVersion = null;
try {
  const manifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  if (typeof manifest.version === "string" && manifest.version.length > 0)
    selectorVersion = manifest.version;
} catch {
  // A selector without a readable manifest still has to launch or explain.
}
const label = selectorVersion ? `dotrelay ${selectorVersion}` : "dotrelay";

// The platform directories this package actually ships, so a missing-binary
// failure can say which platforms this release covers.
let shippedPlatforms = [];
try {
  const entries = await readdir(join(packageDirectory, "dist"), {
    withFileTypes: true,
  });
  shippedPlatforms = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^(linux|darwin|win32)-[a-z0-9]+$/u.test(name))
    .sort();
} catch {
  shippedPlatforms = [];
}

const binaryOverride = process.env.DOTRELAY_BINARY;
const candidates = [
  ...(binaryOverride !== undefined
    ? [{ path: binaryOverride, override: true }]
    : []),
  {
    path: join(packageDirectory, "dist", platformDirectory, platformBinary),
    override: false,
  },
  { path: join(packageDirectory, "dist", platformBinary), override: false },
  {
    path: join(
      packageDirectory,
      "..",
      "..",
      "apps",
      "cli",
      "dist",
      platformBinary,
    ),
    override: false,
  },
];

// Node re-executes a file the kernel cannot execute (ENOEXEC) through the
// system shell, which would turn a corrupted or wrong-architecture binary
// into opaque shell noise; Bun fails the spawn instead. Checking the
// executable's format and architecture before launching keeps both runtimes
// on the same report.
const elfMachineForArch = {
  x64: 62,
  ia32: 3,
  arm64: 183,
  arm: 40,
  riscv64: 243,
  ppc64: 21,
  s390: 22,
  mips: 8,
  mipsel: 8,
};
const machCpuTypeForArch = {
  x64: 0x01000007,
  ia32: 7,
  arm64: 0x0100000c,
  arm: 12,
};
const peMachineForArch = {
  x64: 0x8664,
  ia32: 0x014c,
  arm64: 0xaa64,
  arm: 0x01c0,
};

const isLaunchableExecutable = async (path) => {
  let head = null;
  try {
    const handle = await open(path);
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buffer, 0, 128, 0);
    await handle.close();
    head = buffer.subarray(0, bytesRead);
  } catch {
    return false;
  }
  if (head.length < 4) return false;
  const u16 = (offset, little) =>
    little
      ? head[offset] | (head[offset + 1] << 8)
      : ((head[offset] << 8) | head[offset + 1]) & 0xffff;
  const u32 = (offset, little) =>
    little
      ? head[offset] |
        (head[offset + 1] << 8) |
        (head[offset + 2] << 16) |
        (head[offset + 3] << 24)
      : ((head[offset] << 24) >>> 24) |
        (head[offset + 1] << 16) |
        (head[offset + 2] << 8) |
        head[offset + 3];
  // A shebang wrapper is executable by the kernel even though it is text.
  if (head[0] === 0x23 && head[1] === 0x21) return true;
  // ELF: the architecture is the e_machine field after the 16-byte header.
  if (
    head[0] === 0x7f &&
    head[1] === 0x45 &&
    head[2] === 0x4c &&
    head[3] === 0x46
  ) {
    const expected = elfMachineForArch[process.arch];
    if (expected === undefined) return true;
    const machine = u16(18, head[5] === 1);
    return machine === expected;
  }
  // Mach-O: little-endian magics carry the CPU type after the magic; the
  // big-endian magics are shared with fat binaries, so they stay accepted.
  const magic =
    head[0] === 0xfe || head[0] === 0xca ? u32(0, head[0] === 0xfe) : 0;
  if (magic === 0xfeedface || magic === 0xfeedfacf) {
    const expected = machCpuTypeForArch[process.arch];
    if (expected === undefined) return true;
    return u32(4, true) === expected;
  }
  if (process.platform === "win32" && head[0] === 0x4d && head[1] === 0x5a) {
    const eLfanew = u32(0x3c, true);
    if (
      head.length > eLfanew + 6 &&
      head[eLfanew] === 0x50 &&
      head[eLfanew + 1] === 0x45
    ) {
      const expected = peMachineForArch[process.arch];
      if (expected === undefined) return true;
      return u16(eLfanew + 4, true) === expected;
    }
    // A PE file whose machine field could not be read is left to the
    // launch attempt.
    return true;
  }
  // A recognized native executable that the kernel could not match (for
  // example a fat or big-endian Mach-O) is left to the launch attempt.
  return magic !== 0;
};

// Each candidate is probed for presence, executability, and format, so a
// binary that is present but damaged, mis-built, or unlaunchable is reported
// as such instead of being silently skipped.
const probes = [];
for (const candidate of candidates) {
  let present = false;
  try {
    await access(candidate.path, constants.F_OK);
    present = true;
  } catch {
    present = false;
  }
  let executable = false;
  if (present) {
    try {
      await access(candidate.path, executableMode);
      executable = true;
    } catch {
      executable = false;
    }
  }
  const launchable =
    executable && (await isLaunchableExecutable(candidate.path));
  probes.push({ ...candidate, present, executable, launchable });
}

const reportUnlaunchable = (path) => {
  console.error(
    `${label}: could not start the native binary for ${platformDirectory} (${path}).`,
  );
  console.error(
    "The binary is not launchable on this machine, usually because it was built for another architecture or operating system, or it is not an intact native executable.",
  );
  console.error(
    `Reinstall a release for ${platformDirectory} (npm install -g dotrelay@${selectorVersion ?? "latest"}) or download the matching binary from the DotRelay GitHub releases.`,
  );
  if (binaryOverride !== undefined)
    console.error(
      `If DOTRELAY_BINARY is set, point it at a binary built for ${platformDirectory}.`,
    );
  process.exitCode = 1;
};

const selected = probes.find((probe) => probe.launchable);
const broken = probes.find((probe) => probe.executable);

if (selected) {
  try {
    const child = spawn(selected.path, process.argv.slice(2), {
      stdio: "inherit",
    });
    child.once("error", () => reportUnlaunchable(selected.path));
    child.once("exit", (code, signal) => {
      process.exitCode = signal ? 1 : (code ?? 1);
    });
  } catch {
    // Bun surfaces an unlaunchable binary as a synchronous spawn failure
    // instead of an "error" event.
    reportUnlaunchable(selected.path);
  }
} else if (broken) {
  // Executable in the kernel's eyes but not a native executable for this
  // machine: a corrupted, text, or wrong-architecture file.
  reportUnlaunchable(broken.path);
} else {
  const found = probes.find((probe) => probe.present);
  if (found) {
    console.error(
      `${label}: the native binary for ${platformDirectory} at ${found.path} is not executable.`,
    );
    console.error(
      `Restore the execute permission (chmod +x ${found.path}) or reinstall the release (npm install -g dotrelay@${selectorVersion ?? "latest"}).`,
    );
  } else {
    console.error(
      `${label}: no native binary is packaged for ${platformDirectory}.`,
    );
    if (binaryOverride !== undefined)
      console.error(
        `DOTRELAY_BINARY points at ${binaryOverride}, which does not exist either.`,
      );
    if (shippedPlatforms.length > 0)
      console.error(
        `This package ships native binaries for: ${shippedPlatforms.join(", ")}.`,
      );
    console.error(
      `Reinstall a release for ${platformDirectory} (npm install -g dotrelay@${selectorVersion ?? "latest"} or npm install -g dotrelay@latest) or run dotrelay from a native binary built for ${platformDirectory}.`,
    );
  }
  process.exitCode = 1;
}
