import { access, constants, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliReleaseVersion } from "./build-cli";
import { runCliPackageProbes } from "./cli-package-probes";
import {
  CLI_TARGETS,
  type CliTarget,
  cliBinaryName,
  cliPlatformPackageName,
  cliTargetKey,
  SELECTOR_PACKAGE,
} from "./cli-targets";
import {
  stagedPlatformDirectory,
  stagedSelectorDirectory,
} from "./stage-cli-package";

// Checks the npm packages staged by `bun run package:cli:npm`. In CI every
// release target must be staged; a local run checks what this machine built.
type Manifest = Readonly<{
  name?: string;
  version?: string;
  os?: readonly string[];
  cpu?: readonly string[];
  libc?: readonly string[];
  files?: readonly string[];
  optionalDependencies?: Readonly<Record<string, string>>;
  publishConfig?: Readonly<{ access?: string }>;
}>;

const readManifest = async (directory: string): Promise<Manifest> =>
  JSON.parse(await readFile(join(directory, "package.json"), "utf8"));

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const run = async (
  command: readonly string[],
  cwd?: string,
): Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>> => {
  const child = Bun.spawn([...command], {
    ...(cwd === undefined ? {} : { cwd }),
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "DOTRELAY_BINARY"),
    ),
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

const expectedVersion = await resolveCliReleaseVersion();
const selector = await readManifest(stagedSelectorDirectory);
if (selector.name !== SELECTOR_PACKAGE)
  throw new Error(
    `staged selector is ${selector.name}, not ${SELECTOR_PACKAGE}`,
  );
const version = selector.version ?? "";
for (const target of CLI_TARGETS) {
  const pinned =
    selector.optionalDependencies?.[cliPlatformPackageName(target)];
  if (pinned !== version)
    throw new Error(
      `the selector must pin ${cliPlatformPackageName(target)} to exactly ${version}, got ${pinned}`,
    );
}
if (selector.files?.includes("dist"))
  throw new Error("the npm selector must not ship native binaries");

const staged: CliTarget[] = [];
for (const target of CLI_TARGETS)
  if (await exists(stagedPlatformDirectory(target))) staged.push(target);
const missing = CLI_TARGETS.filter((target) => !staged.includes(target)).map(
  cliTargetKey,
);
if (missing.length > 0) {
  const message = `no npm platform package is staged for ${missing.join(", ")}`;
  if (process.env.CI === "true") throw new Error(message);
  console.warn(`⚠ ${message}; local artifact-only run`);
}

for (const target of staged) {
  const directory = stagedPlatformDirectory(target);
  const manifest = await readManifest(directory);
  const name = cliPlatformPackageName(target);
  if (
    manifest.name !== name ||
    manifest.version !== version ||
    manifest.os?.join() !== target.platform ||
    manifest.cpu?.join() !== target.arch ||
    manifest.libc?.join() !== target.libc ||
    manifest.publishConfig?.access !== "public"
  )
    throw new Error(`${name} has an invalid package.json`);
  const binary = join(directory, "bin", cliBinaryName(target.platform));
  await access(
    binary,
    target.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  // The tarball holds the binary, the license, and the manifest only.
  const packed = await run(["npm", "pack", "--dry-run", "--json", directory]);
  if (packed.exitCode !== 0)
    throw new Error(`npm pack ${name} failed: ${packed.stderr}`);
  const [listing] = JSON.parse(packed.stdout) as {
    files: { path: string; mode: number }[];
  }[];
  const paths = (listing?.files ?? []).map((file) => file.path).sort();
  const expected = [
    `bin/${cliBinaryName(target.platform)}`,
    "LICENSE.md",
    "package.json",
  ].sort();
  if (paths.join() !== expected.join())
    throw new Error(`${name} packs ${paths.join(", ")}`);
}

// Install the packed selector with this machine's packed platform package,
// as npm does for a user, and run the installed command.
const local = staged.find(
  (target) =>
    target.platform === process.platform && target.arch === process.arch,
);
if (local === undefined)
  throw new Error(
    `no npm platform package is staged for this machine (${process.platform}-${process.arch})`,
  );
const workspace = await mkdtemp(join(tmpdir(), "dotrelay-npm-install-"));
try {
  const packed = await run([
    "npm",
    "pack",
    "--json",
    "--pack-destination",
    workspace,
    stagedSelectorDirectory,
    stagedPlatformDirectory(local),
  ]);
  if (packed.exitCode !== 0)
    throw new Error(`npm pack failed: ${packed.stderr}`);
  const tarballs = (JSON.parse(packed.stdout) as { filename: string }[]).map(
    (entry) => join(workspace, entry.filename),
  );
  const project = join(workspace, "project");
  await Bun.write(join(project, "package.json"), "{}\n");
  // --offline: the other platform packages of an unpublished version cannot
  // be fetched; npm skips them as optional dependencies.
  const installed = await run(
    [
      "npm",
      "install",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      ...tarballs,
    ],
    project,
  );
  if (installed.exitCode !== 0)
    throw new Error(`npm install failed: ${installed.stderr}`);
  const command =
    process.platform === "win32"
      ? [
          "node",
          join(
            project,
            "node_modules",
            "@dotrelay",
            "cli",
            "bin",
            "dotrelay.mjs",
          ),
        ]
      : [join(project, "node_modules", ".bin", "dotrelay")];
  const result = await run([...command, "--version"], project);
  // The installed command must surface the release version the staged
  // binary was stamped with, so a release artifact that lost its stamp (or
  // was built from the wrong source) fails the publish gate instead of
  // shipping.
  if (result.exitCode !== 0 || result.stdout.trim() !== expectedVersion)
    throw new Error(
      `installed npm package smoke test failed: expected ${expectedVersion}, got ${result.stdout.trim() || result.stderr}`,
    );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

await runCliPackageProbes();
console.log(
  `✓ npm packages (${SELECTOR_PACKAGE} and ${staged.length} platform package(s)) installed and ran`,
);
