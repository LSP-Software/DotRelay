import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cliDirectory = join(root, "apps", "cli");
const selectorManifestPath = join(root, "packages", "dotrelay", "package.json");

// Only a release version the release tooling would accept may be stamped, so
// a compiled binary can never claim a release it was not built from.
const releaseVersionPattern =
  /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

export const resolveCliReleaseVersion = async (): Promise<string> => {
  const override = process.env.DOTRELAY_CLI_VERSION;
  if (override !== undefined) {
    const normalized = override.replace(/^v/, "");
    if (
      !releaseVersionPattern.test(normalized) ||
      normalized.split(/[.-]/u).every((part) => part === "0")
    )
      throw new Error(
        `DOTRELAY_CLI_VERSION must be a release version such as 1.2.3; got ${override}`,
      );
    return normalized;
  }
  const manifest = (await Bun.file(selectorManifestPath).json()) as {
    readonly version?: unknown;
  };
  if (
    typeof manifest.version === "string" &&
    manifest.version !== "0.0.0" &&
    releaseVersionPattern.test(manifest.version)
  )
    return manifest.version;
  // The unpublished selector version marks a source build, which keeps the
  // foundation identifier the CLI has always reported.
  return "0.0.0-foundation";
};

// The release version is compiled into the binary, so `dotrelay --version`
// agrees with the tagged/npm release the binary was cut from. An explicit
// version overrides the environment/manifest resolution so release-shaped
// builds can be tested without release tooling.
export const buildCli = async (
  version?: string,
  outfile = "dist/dotrelay",
): Promise<string> => {
  const stampedVersion = version ?? (await resolveCliReleaseVersion());
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "src/index.ts",
      "--outfile",
      outfile,
      "--define",
      `__DOTRELAY_RELEASE_VERSION__=${JSON.stringify(stampedVersion)}`,
    ],
    { cwd: cliDirectory, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new Error(`CLI build failed with exit code ${exitCode}`);
  return stampedVersion;
};

if (import.meta.main) {
  const version = await buildCli();
  console.log(`built apps/cli/dist/dotrelay reporting ${version}`);
}
