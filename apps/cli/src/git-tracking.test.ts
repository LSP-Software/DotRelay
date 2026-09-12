import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitTrackingProbe,
  ensureLocalGitExclusion,
  type GitCommandResult,
  type GitCommandRunner,
  type GitTrackingInfo,
} from "./git-tracking";

type Script = (directory: string, args: readonly string[]) => GitCommandResult;

const scriptedRunner =
  (script: Script): GitCommandRunner =>
  async (directory, args) =>
    script(directory, args);

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
});

// The probe resolves from the nearest *existing* directory, so every scripted
// repository points at a real temporary directory on disk.
const scriptForRepo =
  (
    root: string,
    states: Readonly<{
      readonly tracked: readonly string[];
      readonly ignored: readonly string[];
    }>,
  ): Script =>
  (_directory, args) => {
    if (args[0] === "rev-parse" && args[1] === "--git-dir")
      return { stdout: join(root, ".git"), exitCode: 0 };
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return { stdout: root, exitCode: 0 };
    if (args[0] === "ls-files") {
      const pathspec = args[args.length - 1] ?? "";
      if (states.tracked.includes(pathspec)) return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 1 };
    }
    if (args[0] === "check-ignore") {
      const pathspec = args[args.length - 1] ?? "";
      if (states.ignored.includes(pathspec)) return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 1 };
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };

const makeRepo = async (): Promise<string> => {
  const created = await mkdtemp(join(tmpdir(), "dotrelay-gittracking-"));
  temporary.push(created);
  // Git reports fully resolved paths; tests compare against the same form.
  return realpath(created);
};

describe("Git tracking probe", () => {
  test("reports a path tracked in the repository index", async () => {
    const root = await makeRepo();
    const probe = createGitTrackingProbe(
      scriptedRunner(
        scriptForRepo(root, { tracked: ["service.env"], ignored: [] }),
      ),
    );
    const info = await probe(join(root, "service.env"));
    expect(info).toEqual({
      state: "tracked",
      gitDirectory: join(root, ".git"),
      topLevel: root,
      relativePath: "service.env",
    });
  });

  test("reports a path that is untracked and not ignored", async () => {
    const root = await makeRepo();
    const probe = createGitTrackingProbe(
      scriptedRunner(
        scriptForRepo(root, { tracked: ["service.env"], ignored: [] }),
      ),
    );
    const info = await probe(join(root, "local.env"));
    expect(info).toEqual({
      state: "untracked",
      gitDirectory: join(root, ".git"),
      topLevel: root,
      relativePath: "local.env",
    });
  });

  test("reports a path that is ignored even though it is not tracked", async () => {
    const root = await makeRepo();
    const probe = createGitTrackingProbe(
      scriptedRunner(
        scriptForRepo(root, { tracked: [], ignored: ["local.env"] }),
      ),
    );
    expect((await probe(join(root, "local.env"))).state).toBe("ignored");
  });

  test("prefers the tracked state over an ignore pattern match", async () => {
    const root = await makeRepo();
    const probe = createGitTrackingProbe(
      scriptedRunner(
        scriptForRepo(root, {
          tracked: ["service.env"],
          ignored: ["service.env"],
        }),
      ),
    );
    expect((await probe(join(root, "service.env"))).state).toBe("tracked");
  });

  test("reports a path outside any repository without probing further", async () => {
    const calls: string[][] = [];
    const probe = createGitTrackingProbe(
      scriptedRunner((_directory, args) => {
        calls.push([...args]);
        if (args[0] === "rev-parse") return { stdout: "", exitCode: 128 };
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      }),
    );
    const info = await probe("/elsewhere/local.env");
    expect(info).toEqual({ state: "outside" });
    expect(calls).toEqual([["rev-parse", "--git-dir"]]);
  });

  test("fails closed when Git reports a fatal state error", async () => {
    const root = await makeRepo();
    const probe = createGitTrackingProbe(
      scriptedRunner((_directory, args) => {
        if (args[0] === "rev-parse")
          return {
            stdout: args[1] === "--show-toplevel" ? root : join(root, ".git"),
            exitCode: 0,
          };
        if (args[0] === "ls-files")
          return { stdout: "fatal: unable to read index", exitCode: 128 };
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      }),
    );
    await expect(probe(join(root, "local.env"))).rejects.toMatchObject({
      code: "git_tracking_unavailable",
    });
  });

  test("fails closed when the git command cannot run", async () => {
    const probe = createGitTrackingProbe(async () => {
      throw new Error("git binary missing");
    });
    await expect(probe("/elsewhere/local.env")).rejects.toMatchObject({
      code: "git_tracking_unavailable",
    });
  });

  test("resolves a path whose output directory does not exist yet", async () => {
    const root = await makeRepo();
    const probe = createGitTrackingProbe(
      scriptedRunner(scriptForRepo(root, { tracked: [], ignored: [] })),
    );
    const info = await probe(join(root, "nested", "service.env"));
    expect(info).toEqual({
      state: "untracked",
      gitDirectory: join(root, ".git"),
      topLevel: root,
      relativePath: "nested/service.env",
    });
  });
});

describe("repository-local Git exclusion", () => {
  const repoInfo = (root: string, relativePath: string): GitTrackingInfo =>
    Object.freeze({
      state: "untracked",
      gitDirectory: join(root, ".git"),
      topLevel: root,
      relativePath,
    });

  test("establishes an anchored exclusion in the repository's info/exclude", async () => {
    const root = await makeRepo();
    expect(
      await ensureLocalGitExclusion(repoInfo(root, "secrets/local.env")),
    ).toBe("established");
    const exclude = await readFile(
      join(root, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude).toBe("/secrets/local.env\n");
    expect(
      await ensureLocalGitExclusion(repoInfo(root, "secrets/local.env")),
    ).toBe("present");
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toBe(
      "/secrets/local.env\n",
    );
  });

  test("preserves an existing exclusion list without a trailing newline", async () => {
    const root = await makeRepo();
    const excludePath = join(root, ".git", "info", "exclude");
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await Bun.write(excludePath, "# local excludes");
    expect(await ensureLocalGitExclusion(repoInfo(root, ".env"))).toBe(
      "established",
    );
    expect(await readFile(excludePath, "utf8")).toBe(
      "# local excludes\n/.env\n",
    );
  });

  test("recognizes an equivalent unanchored pattern as present", async () => {
    const root = await makeRepo();
    const excludePath = join(root, ".git", "info", "exclude");
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await Bun.write(excludePath, ".env\n");
    expect(await ensureLocalGitExclusion(repoInfo(root, ".env"))).toBe(
      "present",
    );
    expect(await readFile(excludePath, "utf8")).toBe(".env\n");
  });

  test("rejects tracking info without repository context", async () => {
    await expect(
      ensureLocalGitExclusion(Object.freeze({ state: "outside" })),
    ).rejects.toMatchObject({ code: "git_exclusion_failed" });
  });
});

const gitAvailable =
  (await Bun.spawn(["git", "--version"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited) === 0;

const realRepositoryDescribe = gitAvailable ? describe : describe.skip;

realRepositoryDescribe("Git tracking probe against a real repository", () => {
  const runGit = async (directory: string, args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    return stdout.trim();
  };

  const createRepository = async () => {
    const root = await makeRepo();
    await runGit(root, ["init", "-q"]);
    await runGit(root, ["config", "user.email", "dotrelay@example.com"]);
    await runGit(root, ["config", "user.name", "DotRelay Test"]);
    await Bun.write(join(root, "tracked.env"), "TRACKED=1\n");
    await Bun.write(join(root, "untracked.env"), "UNTRACKED=1\n");
    await Bun.write(join(root, "ignored.env"), "IGNORED=1\n");
    await Bun.write(join(root, ".gitignore"), "ignored.env\n");
    await runGit(root, ["add", "tracked.env", ".gitignore"]);
    await runGit(root, ["commit", "-q", "-m", "seed"]);
    return { root };
  };

  test("classifies tracked, untracked, ignored, and outside paths", async () => {
    const { root } = await createRepository();
    const outside = await makeRepo();
    const probe = createGitTrackingProbe();
    const tracked = await probe(join(root, "tracked.env"));
    expect(tracked.state).toBe("tracked");
    expect(tracked.topLevel).toBe(root);
    expect(tracked.gitDirectory).toBe(join(root, ".git"));
    expect((await probe(join(root, "untracked.env"))).state).toBe("untracked");
    expect((await probe(join(root, "ignored.env"))).state).toBe("ignored");
    const outsidePath = join(outside, "local.env");
    await Bun.write(outsidePath, "OUTSIDE=1\n");
    expect((await probe(outsidePath)).state).toBe("outside");
    const subdirectory = join(root, "nested", "service.env");
    const subdirectoryInfo = await probe(subdirectory);
    expect(subdirectoryInfo.state).toBe("untracked");
    expect(await ensureLocalGitExclusion(subdirectoryInfo)).toBe("established");
    expect(
      await readFile(join(root, ".git", "info", "exclude"), "utf8"),
    ).toContain("/nested/service.env");
  });

  test("honors a linked worktree's own index and exclusion list", async () => {
    const { root } = await createRepository();
    const worktree = await makeRepo();
    await runGit(root, ["worktree", "add", "--detach", "-q", worktree, "HEAD"]);
    await Bun.write(join(worktree, "worktree.env"), "WORKTREE=1\n");
    const probe = createGitTrackingProbe();
    const inWorktree = await probe(join(worktree, "worktree.env"));
    expect(inWorktree.state).toBe("untracked");
    expect(inWorktree.gitDirectory).toContain("worktrees");
    expect(inWorktree.topLevel).toBe(worktree);
    expect(await ensureLocalGitExclusion(inWorktree)).toBe("established");
    expect(
      await readFile(
        join(inWorktree.gitDirectory ?? "", "info", "exclude"),
        "utf8",
      ),
    ).toContain("/worktree.env");
    const mainExclude = join(root, ".git", "info", "exclude");
    const mainExcludeExists = await readFile(mainExclude, "utf8")
      .then((content) => content)
      .catch(() => "");
    expect(mainExcludeExists).not.toContain("worktree.env");
    await runGit(root, ["worktree", "remove", "--force", worktree]);
  });
});
