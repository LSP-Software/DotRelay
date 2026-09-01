import { describe, expect, test } from "bun:test";
import {
  detectGitHubRepository,
  readWorktreeContext,
  resolveEnvironmentSelection,
  resolveGitHubRepository,
  writeWorktreeContext,
} from "./context";

describe("repository and worktree context", () => {
  test("normalizes SSH and HTTPS remotes to one GitHub identity", () => {
    expect(
      detectGitHubRepository([
        { name: "origin", url: "git@github.com:LSP-Software/DotRelay.git" },
        {
          name: "upstream",
          url: "https://github.com/LSP-Software/DotRelay",
        },
      ]),
    ).toEqual({
      host: "github.com",
      owner: "LSP-Software",
      name: "DotRelay",
      remoteNames: ["origin", "upstream"],
    });
  });

  test("fails when remotes identify different repositories", () => {
    expect(() =>
      detectGitHubRepository([
        { name: "origin", url: "git@github.com:one/project.git" },
        { name: "upstream", url: "git@github.com:two/project.git" },
      ]),
    ).toThrow("ambiguous");
  });

  test("resolves the stable GitHub numeric repository id", async () => {
    const repository = detectGitHubRepository([
      { name: "origin", url: "git@github.com:LSP-Software/DotRelay.git" },
    ]);
    await expect(
      resolveGitHubRepository(repository, {
        fetch: async (input, init) => {
          expect(input).toBe(
            "https://api.github.com/repos/LSP-Software/DotRelay",
          );
          expect(new Headers(init?.headers).get("User-Agent")).toBe(
            "dotrelay-cli",
          );
          return Response.json({ id: 1311418611, name: "DotRelay" });
        },
      }),
    ).resolves.toMatchObject({
      owner: "LSP-Software",
      name: "DotRelay",
      githubRepositoryId: "1311418611",
    });
  });

  test("stores only opaque ids in worktree context", async () => {
    const file = `${import.meta.dir}/.tmp-context-${crypto.randomUUID()}`;
    const context = {
      serverProfileId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
      environmentId: "00000000-0000-4000-8000-000000000003",
    } as const;
    try {
      await writeWorktreeContext(file, context);
      expect(await readWorktreeContext(file)).toEqual(context);
    } finally {
      await Bun.write(file, "").catch(() => undefined);
      await (await import("node:fs/promises"))
        .unlink(file)
        .catch(() => undefined);
    }
  });

  test("allows a project context before an Environment is selected", async () => {
    const file = `${import.meta.dir}/.tmp-project-context-${crypto.randomUUID()}`;
    const context = {
      serverProfileId: "00000000-0000-4000-8000-000000000001",
      projectId: "00000000-0000-4000-8000-000000000002",
    } as const;
    try {
      await writeWorktreeContext(file, context);
      expect(await readWorktreeContext(file)).toEqual(context);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(file)
        .catch(() => undefined);
    }
  });

  test("resolves an explicit Environment override before worktree context", () => {
    const context = {
      serverProfileId: "profile-id",
      projectId: "project-id",
      environmentId: "worktree-environment-id",
    };
    expect(resolveEnvironmentSelection(undefined, context)).toEqual({
      source: "worktree",
      value: "worktree-environment-id",
    });
    expect(resolveEnvironmentSelection("staging", context)).toEqual({
      source: "override",
      value: "staging",
    });
  });
});
