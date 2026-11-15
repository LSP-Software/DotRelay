import { expect, test } from "bun:test";
import {
  publicationTag,
  publishCommand,
  stableReleaseExists,
} from "./publish-cli";

test("npm publication carries signed provenance", () => {
  const command = publishCommand("/tmp/pkg", "alpha");
  expect(command.slice(0, 3)).toEqual(["npm", "publish", "/tmp/pkg"]);
  expect(command).toContain("--provenance");
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
