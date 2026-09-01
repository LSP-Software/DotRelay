import { describe, expect, test } from "bun:test";
import { main, renderHelp, run, version } from "./index";

describe("CLI foundation", () => {
  test("renders help without requiring a runtime dependency", () => {
    expect(main(["--help"])).toBe(renderHelp());
  });

  test("reports its foundation version", () => {
    expect(main(["--version"])).toBe(version);
  });

  test("reports authentication from the selected profile session", async () => {
    const profilePath = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}`;
    try {
      await Bun.write(
        profilePath,
        JSON.stringify({
          version: 1,
          selected: "relay",
          profiles: [
            {
              name: "relay",
              origin: "https://relay.example",
              pin: {
                origin: "https://relay.example",
                serverProfileId: "00000000-0000-4000-8000-000000000042",
              },
            },
          ],
        }),
      );
      const result = await run(["status", "--json"], {
        profilePath,
        credentials: {
          get: async () => new TextEncoder().encode("session-token"),
          set: async () => undefined,
          delete: async () => undefined,
        },
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        profile: "relay",
        authenticated: true,
      });
      expect(result.stdout).not.toContain("session-token");
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
    }
  });

  test("maps an empty Git remote result to repository_missing", async () => {
    const profilePath = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}`;
    try {
      await Bun.write(
        profilePath,
        JSON.stringify({
          version: 1,
          profiles: [
            {
              name: "relay",
              origin: "https://relay.example",
              pin: {
                origin: "https://relay.example",
                serverProfileId: "00000000-0000-4000-8000-000000000042",
              },
            },
          ],
        }),
      );
      const result = await run(["context", "--profile", "relay", "--json"], {
        profilePath,
        readGitRemotes: async () => [],
      });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "repository_missing",
      });
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
    }
  });
});
