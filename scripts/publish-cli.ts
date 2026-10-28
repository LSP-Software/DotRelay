import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const publicationTag = (version: string): string => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("The CLI package version is invalid");
  const prerelease = version.split("-")[1];
  return prerelease ? (prerelease.split(".")[0] ?? "next") : "latest";
};

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
  const tag = publicationTag(metadata.version);
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
    const child = Bun.spawn(
      [
        "npm",
        "publish",
        packageDirectory,
        "--access",
        "public",
        "--tag",
        tag,
        "--registry=https://registry.npmjs.org/",
      ],
      { env, stdout: "inherit", stderr: "inherit" },
    );
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
