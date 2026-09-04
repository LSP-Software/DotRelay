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

  test("honors a status profile override", async () => {
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
            {
              name: "other",
              origin: "https://other.example",
              pin: {
                origin: "https://other.example",
                serverProfileId: "00000000-0000-4000-8000-000000000043",
              },
            },
          ],
        }),
      );
      const result = await run(["status", "--profile", "other", "--json"], {
        profilePath,
        credentials: {
          get: async (_service, account) =>
            account.includes("000000000043")
              ? new TextEncoder().encode("session-token")
              : null,
          set: async () => undefined,
          delete: async () => undefined,
        },
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        profile: "other",
        origin: "https://other.example",
        authenticated: true,
      });
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
    }
  });

  test("rejects forbidden flags even when help is requested", async () => {
    const result = await run(["--insecure", "--help"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("The command could not complete.\n");
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

  test("links a Project and writes only opaque worktree context", async () => {
    const profilePath = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}`;
    const contextPath = `${import.meta.dir}/.tmp-context-${crypto.randomUUID()}`;
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
      const result = await run(
        [
          "project",
          "link",
          "--team",
          "00000000-0000-4000-8000-000000000001",
          "--json",
        ],
        {
          profilePath,
          worktreeConfig: contextPath,
          readGitRemotes: async () => [
            { name: "origin", url: "git@github.com:LSP-Software/DotRelay.git" },
          ],
          githubFetch: async () => Response.json({ id: 1311418611 }),
          admin: {
            post: async () => ({
              id: "00000000-0000-4000-8000-000000000002",
              teamId: "00000000-0000-4000-8000-000000000001",
              githubRepositoryId: "1311418611",
              lifecycle: "active",
            }),
            get: async () => ({}) as never,
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        projectId: "00000000-0000-4000-8000-000000000002",
      });
      expect(await Bun.file(contextPath).text()).toBe(
        '{"serverProfileId":"00000000-0000-4000-8000-000000000042","projectId":"00000000-0000-4000-8000-000000000002"}\n',
      );
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
      await (await import("node:fs/promises"))
        .unlink(contextPath)
        .catch(() => undefined);
    }
  });

  test("selects an Environment with command-level precedence and preserves context", async () => {
    const profilePath = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}`;
    const contextPath = `${import.meta.dir}/.tmp-context-${crypto.randomUUID()}`;
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
      await Bun.write(
        contextPath,
        JSON.stringify({
          serverProfileId: "00000000-0000-4000-8000-000000000042",
          projectId: "00000000-0000-4000-8000-000000000002",
        }),
      );
      const result = await run(
        [
          "env",
          "use",
          "--environment",
          "00000000-0000-4000-8000-000000000003",
          "--profile",
          "relay",
          "--json",
        ],
        {
          profilePath,
          worktreeConfig: contextPath,
          admin: {
            get: async () => ({
              environments: [
                {
                  id: "00000000-0000-4000-8000-000000000003",
                  projectId: "00000000-0000-4000-8000-000000000002",
                  lifecycle: "active",
                  currentHeadId: null,
                },
              ],
            }),
            post: async () => ({}) as never,
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        environmentId: "00000000-0000-4000-8000-000000000003",
      });
      expect(JSON.parse(await Bun.file(contextPath).text())).toEqual({
        serverProfileId: "00000000-0000-4000-8000-000000000042",
        projectId: "00000000-0000-4000-8000-000000000002",
        environmentId: "00000000-0000-4000-8000-000000000003",
      });
    } finally {
      await (await import("node:fs/promises"))
        .unlink(profilePath)
        .catch(() => undefined);
      await (await import("node:fs/promises"))
        .unlink(contextPath)
        .catch(() => undefined);
    }
  });
});
