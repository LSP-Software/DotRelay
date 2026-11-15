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

// --provenance signs the tarball with the job's OIDC token (id-token: write).
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

const publish = async () => {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this release-only command runs directly, outside Turbo.
  const token = process.env.NODE_AUTH_TOKEN;
  if (!token?.trim() || /[\r\n]/.test(token))
    throw new Error(
      "Set the NPM_TOKEN repository secret to a publishing token with write access to dotrelay and permission to publish from CI.",
    );
  const packageDirectory = resolve(import.meta.dir, "../packages/dotrelay");
  const metadata = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  ) as { name: string; version: string };
  if (metadata.name !== "dotrelay")
    throw new Error("Unexpected CLI package name");
  const tag = publicationTag(
    metadata.version,
    await stableReleaseExists(metadata.name),
  );
  const directory = await mkdtemp(join(tmpdir(), "dotrelay-npm-"));
  const config = join(directory, "npmrc");
  try {
    await writeFile(
      config,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: npm expands the token from its environment; never write the token itself.
      "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n",
      { mode: 0o600 },
    );
    const env = { ...process.env, NPM_CONFIG_USERCONFIG: config };
    const who = Bun.spawn(
      ["npm", "whoami", "--registry=https://registry.npmjs.org/"],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    await Promise.all([
      new Response(who.stdout).text(),
      new Response(who.stderr).text(),
    ]);
    if ((await who.exited) !== 0)
      throw new Error(
        "NPM_TOKEN is missing, expired, or invalid. Replace the repository secret with a token authorized to publish dotrelay.",
      );
    const child = Bun.spawn(publishCommand(packageDirectory, tag), {
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0)
      throw new Error(
        "CLI publication failed. Check NPM_TOKEN has write access to dotrelay and allows CI publishing without an interactive OTP. The release has not been published successfully.",
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
