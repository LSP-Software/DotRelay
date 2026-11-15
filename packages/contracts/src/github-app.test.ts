import { describe, expect, test } from "bun:test";
import {
  gitHubAppInstallUrl,
  isGitHubAppSlug,
  parseGitHubAppDocument,
} from "./api";

describe("GitHub App document", () => {
  test("builds and parses the install link for a slug", () => {
    const installUrl = gitHubAppInstallUrl("dotrelay-dev");
    expect(installUrl).toBe(
      "https://github.com/apps/dotrelay-dev/installations/new",
    );
    expect(parseGitHubAppDocument({ installUrl })).toEqual({ installUrl });
  });

  test("rejects slugs GitHub would not issue", () => {
    for (const slug of ["", "Dot", "-dot", "dot-", "dot_relay", "a/b"])
      expect(isGitHubAppSlug(slug)).toBe(false);
    expect(() => gitHubAppInstallUrl("../evil")).toThrow();
  });

  test("rejects documents that point anywhere but a GitHub App install page", () => {
    for (const value of [
      {},
      { installUrl: 1 },
      { installUrl: "https://evil.example/apps/dotrelay/installations/new" },
      { installUrl: "http://github.com/apps/dotrelay/installations/new" },
      { installUrl: "https://github.com/apps/Dot/installations/new" },
      { installUrl: "https://github.com/apps/dotrelay/installations/new?x=1" },
      {
        installUrl: "https://github.com/apps/dotrelay/installations/new",
        extra: true,
      },
    ])
      expect(() => parseGitHubAppDocument(value)).toThrow();
  });
});
