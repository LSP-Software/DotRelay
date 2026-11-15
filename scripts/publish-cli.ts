import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
// the @dotrelay/cli package (repository, workflow filename, environment).
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
  "--registry=https://registry.npmjs.org/",
];

// npm 11.5.1 is the first release that performs the OIDC exchange.
export const MINIMUM_TRUSTED_PUBLISHING_NPM = [11, 5, 1] as const;

export const supportsTrustedPublishing = (npmVersion: string): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(npmVersion.trim());
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference =
      (actual[index] ?? 0) - MINIMUM_TRUSTED_PUBLISHING_NPM[index];
    if (difference !== 0) return difference > 0;
  }
  return true;
};

const npmVersion = async (env: Record<string, string | undefined>) => {
  const child = Bun.spawn(["npm", "--version"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return (await child.exited) === 0 ? stdout.trim() : "";
};

const publish = async () => {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this release-only command runs directly, outside Turbo.
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
    throw new Error(
      "Trusted publishing needs the GitHub OIDC token. Give the publishing job `permissions: id-token: write`, and run it only from the workflows configured as trusted publishers for @dotrelay/cli on npmjs.com.",
    );
  const packageDirectory = resolve(import.meta.dir, "../packages/dotrelay");
  const metadata = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  ) as { name: string; version: string };
  if (metadata.name !== "@dotrelay/cli")
    throw new Error("Unexpected CLI package name");
  const tag = publicationTag(
    metadata.version,
    await stableReleaseExists(metadata.name),
  );
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
    const version = await npmVersion(env);
    if (!supportsTrustedPublishing(version))
      throw new Error(
        `Trusted publishing needs npm 11.5.1 or later; this job has npm ${version || "(unknown)"}. Install Node 24 with actions/setup-node before publishing.`,
      );
    const child = Bun.spawn(publishCommand(packageDirectory, tag), {
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0)
      throw new Error(
        "CLI publication failed. Check that @dotrelay/cli on npmjs.com lists this repository and workflow file (and, for release.yml, the security-review environment) as a trusted publisher. The release has not been published successfully.",
      );
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
