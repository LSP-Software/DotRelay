#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLaunchableExecutable } from "./is-launchable-executable.mjs";

const packageDirectory = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
);
const platformBinary =
  process.platform === "win32" ? "dotrelay.exe" : "dotrelay";
const platformDirectory = `${process.platform}-${process.arch}`;
// Each release target ships as its own npm package, installed as an optional
// dependency that npm keeps only on the matching os/cpu/libc.
const platformPackage = `@dotrelay/cli-${platformDirectory}`;
const executableMode =
  process.platform === "win32" ? undefined : constants.X_OK;
const installScript =
  process.platform === "win32"
    ? "irm https://raw.githubusercontent.com/LSP-Software/DotRelay/main/scripts/install.ps1 | iex"
    : "curl -fsSL https://raw.githubusercontent.com/LSP-Software/DotRelay/main/scripts/install.sh | sh";
const releasesUrl = "https://github.com/LSP-Software/DotRelay/releases";

// Diagnostics identify the release being run so a failed launch names the
// installation instead of only the platform that failed.
let selectorVersion = null;
// The platform packages this release publishes, from its optional
// dependencies, so a missing-binary failure can say which platforms exist.
let shippedPlatforms = [];
try {
  const manifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  if (typeof manifest.version === "string" && manifest.version.length > 0)
    selectorVersion = manifest.version;
  shippedPlatforms = Object.keys(manifest.optionalDependencies ?? {})
    .map(
      (name) =>
        /^@dotrelay\/cli-((?:linux|darwin|win32)-[a-z0-9]+)$/u.exec(name)?.[1],
    )
    .filter((name) => name !== undefined)
    .sort();
} catch {
  // A selector without a readable manifest still has to launch or explain.
}
const label = selectorVersion ? `dotrelay ${selectorVersion}` : "dotrelay";
const reinstall = `npm install -g @dotrelay/cli@${selectorVersion ?? "latest"}`;

// The platform package resolves through Node's own package lookup from this
// selector, so it is the copy the package manager installed beside it. A
// file elsewhere in the surrounding project is never a candidate. Local
// development points DOTRELAY_BINARY at the monorepo build instead.
let packagedBinary = null;
let packagedVersion = null;
try {
  const manifestPath = createRequire(import.meta.url).resolve(
    `${platformPackage}/package.json`,
  );
  packagedBinary = join(dirname(manifestPath), "bin", platformBinary);
  packagedVersion = JSON.parse(await readFile(manifestPath, "utf8")).version;
} catch {
  // Not installed: reported below unless DOTRELAY_BINARY launches.
}

const binaryOverride = process.env.DOTRELAY_BINARY;
if (binaryOverride !== undefined && !isAbsolute(binaryOverride)) {
  console.error(
    `${label}: DOTRELAY_BINARY must be an absolute path to a native binary (got ${binaryOverride}).`,
  );
  process.exit(1);
}
// A platform package from another release would run a different binary
// than the one this selector names; refuse it instead of mixing versions.
if (
  binaryOverride === undefined &&
  packagedBinary !== null &&
  selectorVersion !== null &&
  packagedVersion !== selectorVersion
) {
  console.error(
    `${label}: the installed ${platformPackage} is version ${packagedVersion ?? "(unknown)"}, not ${selectorVersion}.`,
  );
  console.error(`Reinstall the release (${reinstall}).`);
  process.exit(1);
}
const candidates = [
  ...(binaryOverride !== undefined
    ? [{ path: binaryOverride, override: true }]
    : []),
  ...(packagedBinary !== null
    ? [{ path: packagedBinary, override: false }]
    : []),
];

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
    `Reinstall a release for ${platformDirectory} (${reinstall}) or download the matching binary from ${releasesUrl}.`,
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
    // The selector stays alive while the binary runs, so termination
    // signals sent to it are passed on instead of orphaning the binary.
    const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const forward = (signal) => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    };
    for (const signal of forwardedSignals) process.on(signal, forward);
    child.once("error", () => reportUnlaunchable(selected.path));
    child.once("exit", (code, signal) => {
      for (const forwarded of forwardedSignals) process.off(forwarded, forward);
      if (!signal) {
        process.exitCode = code ?? 1;
        return;
      }
      // Re-raise the signal that ended the binary so the caller sees the
      // same termination; if it does not end this process, report 128+n.
      process.exitCode = 128 + (osConstants.signals[signal] ?? 0);
      try {
        process.kill(process.pid, signal);
      } catch {
        // The exit code above already reports the signal.
      }
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
      `Restore the execute permission (chmod +x ${found.path}) or reinstall the release (${reinstall}).`,
    );
  } else {
    const supported =
      shippedPlatforms.length === 0 ||
      shippedPlatforms.includes(platformDirectory);
    // Bun's Linux builds need glibc; npm skips them on a musl system.
    const report =
      process.platform === "linux" ? process.report?.getReport?.() : undefined;
    const musl =
      report?.header !== undefined && !report.header.glibcVersionRuntime;
    if (packagedBinary !== null) {
      console.error(
        `${label}: the installed ${platformPackage} package has no native binary at ${packagedBinary}.`,
      );
    } else if (supported && !musl) {
      console.error(
        `${label}: no native binary is installed for ${platformDirectory}: the ${platformPackage} package is missing.`,
      );
      console.error(
        "npm installs it as an optional dependency of @dotrelay/cli. It is left out by --omit=optional or --no-optional, or by a lockfile created on another platform.",
      );
    } else {
      console.error(
        `${label}: DotRelay does not publish a native binary for ${platformDirectory}${musl ? " with musl libc (the Linux binaries need glibc)" : ""}.`,
      );
    }
    if (binaryOverride !== undefined)
      console.error(
        `DOTRELAY_BINARY points at ${binaryOverride}, which does not exist either.`,
      );
    if (shippedPlatforms.length > 0)
      console.error(
        `This release publishes native binaries for: ${shippedPlatforms.join(", ")}.`,
      );
    console.error(
      `Reinstall with optional dependencies (${reinstall}), install the standalone binary (${installScript}), download it from ${releasesUrl}, or set DOTRELAY_BINARY to the absolute path of a native binary built for ${platformDirectory}.`,
    );
  }
  process.exitCode = 1;
}
