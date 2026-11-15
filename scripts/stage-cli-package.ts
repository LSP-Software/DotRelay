import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CLI_TARGETS,
  type CliTarget,
  cliBinaryName,
  cliPlatformPackageName,
  cliTargetKey,
  SELECTOR_PACKAGE,
} from "./cli-targets";

const root = join(import.meta.dir, "..");
const selectorSource = join(root, "packages", "dotrelay");

// Native binaries land in <selector>/dist/<platform>-<arch>/, one per build
// matrix job; CI uploads that directory as the job's artifact. The selector
// does not ship it: npm packages are assembled from it under dist/npm/.
export const binaryStagingDirectory = join(selectorSource, "dist");
export const npmStagingDirectory = join(root, "dist", "npm");
export const stagedSelectorDirectory = join(npmStagingDirectory, "cli");
export const stagedPlatformDirectory = (target: CliTarget): string =>
  join(npmStagingDirectory, `cli-${cliTargetKey(target)}`);

// Stages the binary built in this checkout (apps/cli/dist) for this machine,
// or for DOTRELAY_TARGET_PLATFORM/DOTRELAY_TARGET_ARCH.
export const stageCliPackage = async (): Promise<string> => {
  const targetPlatform =
    process.env.DOTRELAY_TARGET_PLATFORM ?? process.platform;
  const targetArch = process.env.DOTRELAY_TARGET_ARCH ?? process.arch;
  const binaryName = cliBinaryName(targetPlatform);
  const source =
    process.env.DOTRELAY_BINARY_SOURCE ??
    join(root, "apps", "cli", "dist", binaryName);
  const destination = join(
    binaryStagingDirectory,
    `${targetPlatform}-${targetArch}`,
    binaryName,
  );
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
  return destination;
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

type SelectorManifest = Record<string, unknown> & {
  readonly name: string;
  readonly version: string;
};

// Assembles the npm packages from the staged binaries: the selector, which
// pins every platform package as an exact optional dependency, and one
// package per target that has a staged binary. With requireAllTargets (the
// publish jobs) a missing target is an error, so the selector never points
// at a platform package that is not published with it.
export const stageNpmPackages = async (
  options: Readonly<{ requireAllTargets: boolean }>,
): Promise<
  Readonly<{
    version: string;
    selector: string;
    platforms: ReadonlyMap<CliTarget, string>;
  }>
> => {
  const manifest = JSON.parse(
    await readFile(join(selectorSource, "package.json"), "utf8"),
  ) as SelectorManifest;
  if (manifest.name !== SELECTOR_PACKAGE)
    throw new Error(`expected ${SELECTOR_PACKAGE} in packages/dotrelay`);
  const { version } = manifest;
  const license = join(root, "LICENSE.md");

  await rm(npmStagingDirectory, { recursive: true, force: true });
  await mkdir(stagedSelectorDirectory, { recursive: true });
  await cp(join(selectorSource, "bin"), join(stagedSelectorDirectory, "bin"), {
    recursive: true,
  });
  await copyFile(
    join(selectorSource, "README.md"),
    join(stagedSelectorDirectory, "README.md"),
  );
  await copyFile(license, join(stagedSelectorDirectory, "LICENSE.md"));
  await writeJson(join(stagedSelectorDirectory, "package.json"), {
    ...manifest,
    optionalDependencies: Object.fromEntries(
      CLI_TARGETS.map((target) => [cliPlatformPackageName(target), version]),
    ),
  });

  const platforms = new Map<CliTarget, string>();
  const missing: string[] = [];
  for (const target of CLI_TARGETS) {
    const binaryName = cliBinaryName(target.platform);
    const binary = join(
      binaryStagingDirectory,
      cliTargetKey(target),
      binaryName,
    );
    if (!(await exists(binary))) {
      missing.push(cliTargetKey(target));
      continue;
    }
    const directory = stagedPlatformDirectory(target);
    await mkdir(join(directory, "bin"), { recursive: true });
    await copyFile(binary, join(directory, "bin", binaryName));
    // The artifact round trip drops the execute bit; npm keeps the mode.
    if (process.platform !== "win32")
      await chmod(join(directory, "bin", binaryName), 0o755);
    await copyFile(license, join(directory, "LICENSE.md"));
    await writeJson(join(directory, "package.json"), {
      name: cliPlatformPackageName(target),
      version,
      description: `The ${cliTargetKey(target)} native binary for ${SELECTOR_PACKAGE}. Install ${SELECTOR_PACKAGE} instead.`,
      license: manifest.license,
      homepage: manifest.homepage,
      repository: manifest.repository,
      bugs: manifest.bugs,
      publishConfig: { access: "public" },
      os: [target.platform],
      cpu: [target.arch],
      ...(target.libc ? { libc: [target.libc] } : {}),
      files: ["bin", "LICENSE.md"],
    });
    platforms.set(target, directory);
  }
  if (missing.length > 0) {
    const message = `no staged binary for ${missing.join(", ")} under ${binaryStagingDirectory}`;
    if (options.requireAllTargets) throw new Error(message);
    console.warn(`⚠ ${message}; staged the available platform packages only`);
  }
  return { version, selector: stagedSelectorDirectory, platforms };
};

const main = async (): Promise<void> => {
  if (Bun.argv[2] !== "npm") {
    console.log(`staged ${await stageCliPackage()}`);
    return;
  }
  const staged = await stageNpmPackages({
    requireAllTargets: Bun.argv.includes("--all"),
  });
  const platformPackages = [...staged.platforms.keys()].map(
    cliPlatformPackageName,
  );
  console.log(
    `staged ${SELECTOR_PACKAGE}@${staged.version} and ${platformPackages.join(", ")}`,
  );
};

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
