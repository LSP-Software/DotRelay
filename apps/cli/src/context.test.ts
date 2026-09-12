import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  detectGitHubRepository,
  readWorktreeContext,
  repositoryChoiceFrom,
  resolveEnvironmentSelection,
  resolveGitHubRepository,
  selectGitHubRepository,
  writeWorktreeContext,
} from "./context";
import { CliError, CliInvocationError } from "./errors";

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
        environment: {},
        fetch: async (input, init) => {
          expect(input).toBe(
            "https://api.github.com/repos/LSP-Software/DotRelay",
          );
          expect(new Headers(init?.headers).get("User-Agent")).toBe(
            "dotrelay-cli",
          );
          expect(new Headers(init?.headers).get("Authorization")).toBeNull();
          return Response.json({ id: 1311418611, name: "DotRelay" });
        },
      }),
    ).resolves.toMatchObject({
      owner: "LSP-Software",
      name: "DotRelay",
      githubRepositoryId: "1311418611",
    });
  });

  test("authenticates GitHub lookups with a configured token", async () => {
    const repository = detectGitHubRepository([
      { name: "origin", url: "git@github.com:LSP-Software/DotRelay.git" },
    ]);
    await expect(
      resolveGitHubRepository(repository, {
        environment: { GITHUB_TOKEN: "live-test-token" },
        fetch: async (input, init) => {
          expect(input).toBe(
            "https://api.github.com/repos/LSP-Software/DotRelay",
          );
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            "Bearer live-test-token",
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

describe("explicit GitHub repository choice", () => {
  const forkRemote = Object.freeze({
    name: "origin",
    url: "git@github.com:my-user/DotRelay.git",
  });
  const sourceRemote = Object.freeze({
    name: "upstream",
    url: "git@github.com:LSP-Software/DotRelay.git",
  });
  const forkRemotes = Object.freeze([forkRemote, sourceRemote]);
  const noPrompt = async (): Promise<string> => {
    throw new Error("selection must not prompt");
  };

  test("detects a single shared identity without recording a choice", async () => {
    const selection = await selectGitHubRepository([
      { name: "origin", url: "git@github.com:LSP-Software/DotRelay.git" },
      { name: "upstream", url: "https://github.com/LSP-Software/DotRelay" },
    ]);
    expect(selection.source).toBe("detected");
    expect(selection.repository).toEqual({
      host: "github.com",
      owner: "LSP-Software",
      name: "DotRelay",
      remoteNames: ["origin", "upstream"],
    });
  });

  test("reports the exact --remote choices under --no-input", async () => {
    let error: unknown;
    try {
      await selectGitHubRepository(forkRemotes, { noInput: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    const rejection = error as CliError;
    expect(rejection.code).toBe("repository_ambiguous");
    expect(rejection.message).toContain("--remote <remote-name>");
    expect(rejection.message).toContain("origin — my-user/DotRelay");
    expect(rejection.message).toContain("upstream — LSP-Software/DotRelay");
    // Remote URLs may carry credentials; the diagnostic never shows one.
    expect(rejection.message).not.toContain("git@");
    expect(rejection.message).not.toContain("https://");
  });

  test("honors an explicit --remote override", async () => {
    const selection = await selectGitHubRepository(forkRemotes, {
      remoteName: "origin",
    });
    expect(selection.source).toBe("override");
    expect(selection.remoteName).toBe("origin");
    expect(selection.repository.owner).toBe("my-user");
    expect(selection.choice).toEqual({
      remote: "origin",
      owner: "my-user",
      name: "DotRelay",
    });
  });

  test("rejects a --remote value that is not a usable GitHub remote", async () => {
    await expect(
      selectGitHubRepository(
        [
          ...forkRemotes,
          Object.freeze({
            name: "vendor",
            url: "https://gitlab.example/vendor/repo.git",
          }),
        ],
        { remoteName: "vendor" },
      ),
    ).rejects.toThrow("not a GitHub remote");
    await expect(
      selectGitHubRepository(forkRemotes, { remoteName: "missing" }),
    ).rejects.toThrow("was not found");
  });

  test("asks which remote identifies the repository, listing names without URLs", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rendered: string[] = [];
    output.on("data", (chunk) =>
      rendered.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
    );
    input.write("2\n");
    input.end();
    const selection = await selectGitHubRepository(forkRemotes, {
      terminal: { input, output },
    });
    const renderedText = rendered.join("");
    expect(selection.source).toBe("interactive");
    expect(selection.remoteName).toBe("upstream");
    expect(selection.repository.owner).toBe("LSP-Software");
    expect(renderedText).toContain("origin — my-user/DotRelay");
    expect(renderedText).toContain("upstream — LSP-Software/DotRelay");
    expect(renderedText).not.toContain("git@github.com");
  });

  test("reuses a recorded choice while the remote still points at the same repository", async () => {
    const selection = await selectGitHubRepository(forkRemotes, {
      saved: { remote: "upstream", owner: "LSP-Software", name: "DotRelay" },
      prompt: noPrompt,
    });
    expect(selection.source).toBe("saved");
    expect(selection.repository.owner).toBe("LSP-Software");
  });

  test("re-asks when the recorded remote is repointed at another repository", async () => {
    const error = await selectGitHubRepository(
      Object.freeze([
        Object.freeze({
          name: "origin",
          url: "git@github.com:LSP-Software/DotRelay.git",
        }),
        Object.freeze({
          name: "upstream",
          url: "git@github.com:my-user/DotRelay.git",
        }),
      ]),
      {
        saved: { remote: "origin", owner: "my-user", name: "DotRelay" },
        noInput: true,
      },
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("repository_ambiguous");
  });

  test("falls back to detection when the recorded remote is removed", async () => {
    const selection = await selectGitHubRepository([forkRemote], {
      saved: { remote: "upstream", owner: "LSP-Software", name: "DotRelay" },
      prompt: noPrompt,
    });
    expect(selection.source).toBe("detected");
    expect(selection.repository.owner).toBe("my-user");
  });

  test("records only opaque identifiers, never the remote URL", async () => {
    const file = `${import.meta.dir}/.tmp-choice-${crypto.randomUUID()}`;
    try {
      const choice = {
        repositoryRemote: "upstream",
        repositoryOwner: "LSP-Software",
        repositoryName: "DotRelay",
      };
      await writeWorktreeContext(file, choice);
      const text = await Bun.file(file).text();
      expect(text).not.toContain("git@");
      expect(text).not.toContain("https://");
      expect(await readWorktreeContext(file)).toEqual(choice);
      expect(repositoryChoiceFrom(await readWorktreeContext(file))).toEqual({
        remote: "upstream",
        owner: "LSP-Software",
        name: "DotRelay",
      });
    } finally {
      await Bun.write(file, "").catch(() => undefined);
      await (await import("node:fs/promises"))
        .unlink(file)
        .catch(() => undefined);
    }
  });

  test("mixes the repository choice with profile and Project ids", async () => {
    const file = `${import.meta.dir}/.tmp-choice-mixed-${crypto.randomUUID()}`;
    const context = {
      serverProfileId: "00000000-0000-4000-8000-000000000042",
      projectId: "00000000-0000-4000-8000-000000000002",
      environmentId: "00000000-0000-4000-8000-000000000003",
      repositoryRemote: "origin",
      repositoryOwner: "my-user",
      repositoryName: "DotRelay",
    };
    try {
      await writeWorktreeContext(file, context);
      expect(await readWorktreeContext(file)).toEqual(context);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(file)
        .catch(() => undefined);
    }
  });

  test("rejects a partial repository choice", async () => {
    const file = `${import.meta.dir}/.tmp-choice-partial-${crypto.randomUUID()}`;
    try {
      await expect(
        writeWorktreeContext(file, {
          serverProfileId: "00000000-0000-4000-8000-000000000042",
          projectId: "00000000-0000-4000-8000-000000000002",
          repositoryRemote: "origin",
        }),
      ).rejects.toThrow(CliInvocationError);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(file)
        .catch(() => undefined);
    }
  });

  test("rejects recorded values that are not identifiers", async () => {
    const file = `${import.meta.dir}/.tmp-choice-invalid-${crypto.randomUUID()}`;
    try {
      await expect(
        writeWorktreeContext(file, {
          repositoryRemote: "git@github.com:my-user/DotRelay.git",
          repositoryOwner: "my-user",
          repositoryName: "DotRelay",
        }),
      ).rejects.toThrow(CliInvocationError);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(file)
        .catch(() => undefined);
    }
  });
});
