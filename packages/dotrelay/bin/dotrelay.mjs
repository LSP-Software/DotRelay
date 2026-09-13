#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, constants, readdir, readFile } from "node:fs/promises";
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

// Each candidate is probed for presence and executability separately, so a
// binary that is present but damaged or unlaunchable is reported as such
// instead of being silently skipped.
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
  probes.push({ ...candidate, present, executable });
}

const ready = probes.find((probe) => probe.executable);

if (ready) {
  const reportUnlaunchable = () => {
    console.error(
      `${label}: could not start the native binary for ${platformDirectory} (${ready.path}).`,
    );
    console.error(
      "The binary is not launchable on this machine, usually because it was built for another architecture or operating system.",
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
  try {
    const child = spawn(ready.path, process.argv.slice(2), {
      stdio: "inherit",
    });
    child.once("error", reportUnlaunchable);
    child.once("exit", (code, signal) => {
      process.exitCode = signal ? 1 : (code ?? 1);
    });
  } catch {
    // Bun surfaces an unlaunchable binary as a synchronous spawn failure
    // instead of an "error" event.
    reportUnlaunchable();
  }
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
