import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CliError } from "./errors";

export type GitTrackingState = "tracked" | "untracked" | "ignored" | "outside";

export type GitTrackingInfo = Readonly<{
  readonly state: GitTrackingState;
  /** Absolute repository git directory, when the path is inside a repository. */
  readonly gitDirectory?: string;
  /** Absolute repository top-level directory, when the path is inside a repository. */
  readonly topLevel?: string;
  /** Repository-relative path, when the path is inside a repository. */
  readonly relativePath?: string;
}>;

export type GitTrackingProbe = (path: string) => Promise<GitTrackingInfo>;

export type GitCommandResult = Readonly<{
  readonly stdout: string;
  readonly exitCode: number;
}>;

export type GitCommandRunner = (
  directory: string,
  args: readonly string[],
) => Promise<GitCommandResult>;

const runGit: GitCommandRunner = async (directory, args) => {
  const child = Bun.spawn(["git", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), exitCode };
};

const trackingUnavailable = (path: string): CliError =>
  new CliError(
    "local-io",
    `could not determine the Git tracking state of ${path}`,
    {},
    "git_tracking_unavailable",
  );

const exclusionFailed = (path: string): CliError =>
  new CliError(
    "local-io",
    `could not update the repository-local Git exclusion for ${path}`,
    {},
    "git_exclusion_failed",
  );

// The output directory may not exist yet; the repository boundary is always
// an existing ancestor, so probe from the nearest one that does.
const nearestExistingDirectory = async (path: string): Promise<string> => {
  let directory = dirname(resolve(path));
  for (;;) {
    try {
      if ((await stat(directory)).isDirectory()) return directory;
    } catch {
      // keep walking up
    }
    const parent = dirname(directory);
    if (parent === directory) return directory;
    directory = parent;
  }
};

// Git reports repository paths fully resolved, so the target must be resolved
// as well: symlinked mount points (such as /var on macOS) would otherwise
// make a file inside the repository compare as outside of it.
const realProbeContext = async (path: string) => {
  const target = resolve(path);
  const probeDirectory = await nearestExistingDirectory(target);
  const realProbeDirectory = await realpath(probeDirectory);
  return {
    realTarget: join(realProbeDirectory, relative(probeDirectory, target)),
    realProbeDirectory,
    pathspec: relative(probeDirectory, target),
  };
};

export const createGitTrackingProbe = (
  runCommand: GitCommandRunner = runGit,
): GitTrackingProbe => {
  return async (path) => {
    let realTarget: string;
    let realProbeDirectory: string;
    let pathspec: string;
    try {
      const context = await realProbeContext(path);
      realTarget = context.realTarget;
      realProbeDirectory = context.realProbeDirectory;
      pathspec = context.pathspec;
    } catch {
      throw trackingUnavailable(resolve(path));
    }
    const run = async (args: readonly string[]): Promise<GitCommandResult> => {
      try {
        return await runCommand(realProbeDirectory, args);
      } catch {
        throw trackingUnavailable(realTarget);
      }
    };
    const outside: GitTrackingInfo = Object.freeze({ state: "outside" });
    let gitDirectory: string;
    let topLevel: string;
    try {
      const gitDirectoryProbe = await run(["rev-parse", "--git-dir"]);
      if (gitDirectoryProbe.exitCode !== 0) return outside;
      const topLevelProbe = await run(["rev-parse", "--show-toplevel"]);
      if (topLevelProbe.exitCode !== 0) return outside;
      gitDirectory = resolve(realProbeDirectory, gitDirectoryProbe.stdout);
      topLevel = resolve(realProbeDirectory, topLevelProbe.stdout);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw trackingUnavailable(realTarget);
    }
    const relativeToTop = relative(topLevel, realTarget);
    if (
      relativeToTop === "" ||
      relativeToTop.startsWith("..") ||
      isAbsolute(relativeToTop)
    )
      return outside;
    const inRepository = Object.freeze({ gitDirectory, topLevel });
    const inRepo = (state: GitTrackingState): GitTrackingInfo =>
      Object.freeze({
        state,
        ...inRepository,
        relativePath: relativeToTop,
      });
    const inIndex = await run(["ls-files", "--error-unmatch", "--", pathspec]);
    if (inIndex.exitCode === 0) return inRepo("tracked");
    if (inIndex.exitCode !== 1) throw trackingUnavailable(realTarget);
    const ignored = await run(["check-ignore", "--quiet", "--", pathspec]);
    if (ignored.exitCode === 0) return inRepo("ignored");
    if (ignored.exitCode !== 1) throw trackingUnavailable(realTarget);
    return inRepo("untracked");
  };
};

// .git/info/exclude is repository-local: it is never committed and never
// changes tracked content, so it is safe for the CLI to maintain on its own.
export const ensureLocalGitExclusion = async (
  info: GitTrackingInfo,
): Promise<"established" | "present"> => {
  if (!info.gitDirectory || !info.topLevel || !info.relativePath)
    throw new CliError(
      "local-io",
      "could not update the repository-local Git exclusion",
      {},
      "git_exclusion_failed",
    );
  const pattern = `/${info.relativePath}`;
  const excludePath = join(info.gitDirectory, "info", "exclude");
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw exclusionFailed(info.relativePath);
  }
  const existing = current
    .split("\n")
    .some((line) => line === pattern || line === info.relativePath);
  if (existing) return "present";
  const next =
    (current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current) +
    `${pattern}\n`;
  try {
    await mkdir(dirname(excludePath), { recursive: true, mode: 0o755 });
    await writeFile(excludePath, next, { mode: 0o644 });
  } catch {
    throw exclusionFailed(info.relativePath);
  }
  return "established";
};
