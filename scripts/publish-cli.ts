import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_TARGETS,
  cliPlatformPackageName,
  SELECTOR_PACKAGE,
} from "./cli-targets";
import {
  stagedPlatformDirectory,
  stagedSelectorDirectory,
} from "./stage-cli-package";

// Each publish names its dist-tag: stable releases move "latest", and a
// prerelease uses its first identifier (alpha, beta, rc, dev). Until the first
// stable release exists, alpha/beta/rc builds are the product, so they also
// move "latest" and `npm install -g @dotrelay/cli` installs them. Dev builds
// from main never do.
export const publicationTag = (
  version: string,
  stableReleaseExists: boolean,
): string => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("The CLI package version is invalid");
  const separator = version.indexOf("-");
  if (separator === -1) return "latest";
  const identifier = version.slice(separator + 1).split(".")[0] ?? "";
  // A prerelease identifier that is literally "latest" (v1.2.3-latest.1), or
  // empty (1.2.3--x), is refused rather than guessed.
  if (!/^[0-9A-Za-z]+$/.test(identifier) || identifier === "latest")
    throw new Error(
      "Prerelease versions need an identifier such as alpha, beta, rc, or dev",
    );
  if (identifier === "dev") return "dev";
  return stableReleaseExists ? identifier : "latest";
};

const isStableVersion = (version: string): boolean =>
  /^\d+\.\d+\.\d+$/.test(version);

// Reads the published versions; a package that has never been published has
// no stable release. Any other registry failure stops the publish.
export const stableReleaseExists = async (
  packageName: string,
  fetchRegistry: typeof fetch = fetch,
): Promise<boolean> => {
  const response = await fetchRegistry(
    `https://registry.npmjs.org/${packageName.replaceAll("/", "%2f")}`,
    { headers: { accept: "application/vnd.npm.install-v1+json" } },
  );
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error(
      `Could not read ${packageName} from the npm registry (HTTP ${response.status}); the release has not been published.`,
    );
  const body = (await response.json()) as {
    readonly versions?: Record<string, unknown>;
  };
  return Object.keys(body.versions ?? {}).some(isStableVersion);
};

// Trusted publishing (OIDC): npm exchanges the job's GitHub OIDC token for a
// short-lived publish credential, so no long-lived npm token exists anywhere.
// The registry matches the token against the trusted publishers configured on
// each package (repository, workflow filename, environment).
// --provenance is automatic under trusted publishing; it is kept explicit so a
// publish that somehow fell back to a token still carries a provenance
// statement.
export const publishCommand = (
  packageDirectory: string,
  tag: string,
): string[] => [
  "npm",
  "publish",
  packageDirectory,
  "--access",
  "public",
  "--tag",
  tag,
  "--provenance",
  "--ignore-scripts",
  "--registry=https://registry.npmjs.org/",
];

// npm 11.5.1 is the first release that performs the OIDC exchange.
export const MINIMUM_TRUSTED_PUBLISHING_NPM = [11, 5, 1] as const;

export const supportsTrustedPublishing = (npmVersion: string): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(npmVersion.trim());
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (const [index, minimum] of MINIMUM_TRUSTED_PUBLISHING_NPM.entries()) {
    const difference = (actual[index] ?? 0) - minimum;
    if (difference !== 0) return difference > 0;
  }
  return true;
};

// Publication order: every platform package first, the selector last, so a
// published selector never pins a platform package that does not exist.
export const publicationOrder = (): readonly Readonly<{
  name: string;
  directory: string;
}>[] => [
  ...CLI_TARGETS.map((target) => ({
    name: cliPlatformPackageName(target),
    directory: stagedPlatformDirectory(target),
  })),
  { name: SELECTOR_PACKAGE, directory: stagedSelectorDirectory },
];

type Completed = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

// `npm view <name>@<version> version` prints the version when it exists,
// prints nothing for an unknown version of an existing package, and fails
// with E404 for a package that does not exist. Anything else is an error, so
// a registry outage never reads as "not yet published".
export const isPublished = (result: Completed, version: string): boolean => {
  if (result.exitCode === 0) {
    const printed = result.stdout.trim().replace(/^"|"$/g, "");
    if (printed === version) return true;
    if (printed === "") return false;
    throw new Error(`npm view returned an unexpected version: ${printed}`);
  }
  if (/\bE404\b/.test(result.stderr)) return false;
  throw new Error(`npm view failed: ${result.stderr.trim()}`);
};

const capture = async (
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<Completed> => {
  const child = Bun.spawn([...command], {
    env,
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

const npmVersion = async (env: Record<string, string | undefined>) => {
  const result = await capture(["npm", "--version"], env);
  return result.exitCode === 0 ? result.stdout.trim() : "";
};

const readManifest = async (
  directory: string,
): Promise<{ name?: unknown; version?: unknown }> =>
  JSON.parse(await readFile(join(directory, "package.json"), "utf8"));

const publish = async () => {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this release-only command runs directly, outside Turbo.
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
    throw new Error(
      "Trusted publishing needs the GitHub OIDC token. Give the publishing job `permissions: id-token: write`, and run it only from the workflows configured as trusted publishers for every @dotrelay/cli package on npmjs.com.",
    );
  const selector = await readManifest(stagedSelectorDirectory);
  if (
    selector.name !== SELECTOR_PACKAGE ||
    typeof selector.version !== "string"
  )
    throw new Error(
      "Stage the npm packages with `bun run package:cli:npm --all` first",
    );
  const version = selector.version;
  // Platform packages share the selector's tag, so the selector's history
  // decides whether a prerelease still moves "latest".
  const tag = publicationTag(
    version,
    await stableReleaseExists(SELECTOR_PACKAGE),
  );
  const packages = publicationOrder();
  // Every package must be staged at the selector's version before anything
  // is published.
  for (const entry of packages) {
    const manifest = await readManifest(entry.directory).catch(() => ({}));
    if (
      !("name" in manifest) ||
      manifest.name !== entry.name ||
      manifest.version !== version
    )
      throw new Error(
        `${entry.name}@${version} is not staged in ${entry.directory}`,
      );
  }
  const directory = await mkdtemp(join(tmpdir(), "dotrelay-npm-"));
  const config = join(directory, "npmrc");
  try {
    // A clean user config with no credentials: a stray token must never be
    // preferred over the OIDC exchange.
    await writeFile(config, "registry=https://registry.npmjs.org/\n", {
      mode: 0o600,
    });
    const {
      NODE_AUTH_TOKEN: _ignored,
      NPM_TOKEN: _alsoIgnored,
      ...rest
    } = process.env;
    const env = { ...rest, NPM_CONFIG_USERCONFIG: config };
    const npm = await npmVersion(env);
    if (!supportsTrustedPublishing(npm))
      throw new Error(
        `Trusted publishing needs npm 11.5.1 or later; this job has npm ${npm || "(unknown)"}. Install Node 24 with actions/setup-node before publishing.`,
      );
    for (const entry of packages) {
      // A re-run after a partial failure skips what the registry already
      // has: a published version can never be replaced, and is never
      // unpublished.
      const view = await capture(
        [
          "npm",
          "view",
          `${entry.name}@${version}`,
          "version",
          "--registry=https://registry.npmjs.org/",
        ],
        env,
      );
      if (isPublished(view, version)) {
        console.log(`${entry.name}@${version} is already published; skipping`);
        continue;
      }
      const child = Bun.spawn(publishCommand(entry.directory, tag), {
        env,
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await child.exited) !== 0)
        throw new Error(
          `Publishing ${entry.name}@${version} failed. Check that ${entry.name} exists on npmjs.com and lists this repository and workflow file (and, for release.yml, the security-review environment) as a trusted publisher. Packages published before it stay published; re-run the job after fixing the cause.`,
        );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  await publish().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "CLI publication failed",
    );
    process.exitCode = 1;
  });
}
