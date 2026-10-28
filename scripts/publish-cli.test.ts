import { expect, test } from "bun:test";
import { publicationTag } from "./publish-cli";

test("prereleases never update the stable npm tag", () => {
  expect(publicationTag("0.1.0-alpha.1")).toBe("alpha");
  expect(publicationTag("0.0.0-dev.abc123")).toBe("dev");
  expect(publicationTag("0.1.0-rc.1")).toBe("rc");
  expect(publicationTag("0.1.0")).toBe("latest");
  expect(() => publicationTag("")).toThrow();
});

test("a latest-looking prerelease identifier is rejected, not published", () => {
  expect(() => publicationTag("1.2.3-latest.1")).toThrow(
    /cannot publish to the latest npm tag/,
  );
  expect(() => publicationTag("1.2.3--x")).toThrow(
    /cannot publish to the latest npm tag/,
  );
});
