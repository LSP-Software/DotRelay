import { expect, test } from "bun:test";
import { CLI_TARGETS, cliPlatformPackageName } from "./cli-targets";
import {
  isPublished,
  publicationOrder,
  publicationTag,
  publishCommand,
  stableReleaseExists,
  supportsTrustedPublishing,
} from "./publish-cli";

test("npm publication carries signed provenance", () => {
  const command = publishCommand("/tmp/pkg", "alpha");
  expect(command.slice(0, 3)).toEqual(["npm", "publish", "/tmp/pkg"]);
  expect(command).toContain("--provenance");
  // The publishing job holds OIDC credentials, so npm runs no lifecycle
  // scripts there.
  expect(command).toContain("--ignore-scripts");
  expect(command[command.indexOf("--tag") + 1]).toBe("alpha");
});

test("prereleases move latest only until a stable release exists", () => {
  expect(publicationTag("0.1.0", true)).toBe("latest");
  expect(publicationTag("0.1.0", false)).toBe("latest");
  expect(publicationTag("0.1.0-alpha.1", false)).toBe("latest");
  expect(publicationTag("0.1.0-rc.1", false)).toBe("latest");
  expect(publicationTag("0.1.0-alpha.1", true)).toBe("alpha");
  expect(publicationTag("0.1.0-rc.1", true)).toBe("rc");
  expect(publicationTag("0.0.0-dev.abc123", false)).toBe("dev");
  expect(publicationTag("0.0.0-dev.abc123", true)).toBe("dev");
  expect(() => publicationTag("", false)).toThrow();
});

test("a latest-looking or empty prerelease identifier is rejected", () => {
  for (const version of ["1.2.3-latest.1", "1.2.3--x"])
    for (const stable of [true, false])
      expect(() => publicationTag(version, stable)).toThrow(
        /identifier such as alpha/,
      );
});

test("only an unsuffixed published version counts as a stable release", async () => {
  const registry = (status: number, versions?: readonly string[]) =>
    (async () =>
      new Response(
        JSON.stringify({
          versions: Object.fromEntries((versions ?? []).map((v) => [v, {}])),
        }),
        { status },
      )) as unknown as typeof fetch;
  expect(await stableReleaseExists("@dotrelay/cli", registry(404))).toBe(false);
  expect(
    await stableReleaseExists(
      "@dotrelay/cli",
      registry(200, ["0.0.0-bootstrap", "0.1.0-alpha.1"]),
    ),
  ).toBe(false);
  expect(
    await stableReleaseExists(
      "@dotrelay/cli",
      registry(200, ["0.1.0-alpha.1", "1.0.0"]),
    ),
  ).toBe(true);
  await expect(
    stableReleaseExists("@dotrelay/cli", registry(500)),
  ).rejects.toThrow(/HTTP 500/);
});

test("trusted publishing requires npm 11.5.1 or later", () => {
  expect(supportsTrustedPublishing("11.5.1")).toBe(true);
  expect(supportsTrustedPublishing("11.19.1\n")).toBe(true);
  expect(supportsTrustedPublishing("12.0.0")).toBe(true);
  expect(supportsTrustedPublishing("11.5.0")).toBe(false);
  expect(supportsTrustedPublishing("10.9.4")).toBe(false);
  expect(supportsTrustedPublishing("")).toBe(false);
});

test("every platform package publishes before the selector", () => {
  const names = publicationOrder().map((entry) => entry.name);
  expect(names.at(-1)).toBe("@dotrelay/cli");
  expect(names.slice(0, -1)).toEqual(CLI_TARGETS.map(cliPlatformPackageName));
  expect(names).toEqual([
    "@dotrelay/cli-linux-x64",
    "@dotrelay/cli-linux-arm64",
    "@dotrelay/cli-darwin-x64",
    "@dotrelay/cli-darwin-arm64",
    "@dotrelay/cli-win32-x64",
    "@dotrelay/cli",
  ]);
});

test("a re-run skips only versions the registry already has", () => {
  const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
  expect(isPublished(ok("1.2.3\n"), "1.2.3")).toBe(true);
  expect(isPublished(ok(""), "1.2.3")).toBe(false);
  expect(
    isPublished(
      {
        stdout: "",
        stderr: "npm error code E404\nnpm error 404 Not Found",
        exitCode: 1,
      },
      "1.2.3",
    ),
  ).toBe(false);
  expect(() =>
    isPublished(
      { stdout: "", stderr: "npm error code ECONNRESET", exitCode: 1 },
      "1.2.3",
    ),
  ).toThrow(/npm view failed/);
  expect(() => isPublished(ok("1.2.4"), "1.2.3")).toThrow(/unexpected/);
});
