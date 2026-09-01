import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError, CliInvocationError } from "./errors";
import { atomicWriteProtectedFile } from "./output";

export type GitRemote = Readonly<{
  readonly name: string;
  readonly url: string;
}>;
export type GitHubRepository = Readonly<{
  readonly host: "github.com";
  readonly owner: string;
  readonly name: string;
  readonly remoteNames: readonly string[];
}>;

export type WorktreeContext = Readonly<{
  readonly serverProfileId: string;
  readonly projectId: string;
  readonly environmentId?: string;
}>;

export type EnvironmentSelection = Readonly<{
  readonly source: "override" | "worktree";
  readonly value: string;
}>;

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export const resolveEnvironmentSelection = (
  override: string | undefined,
  context: WorktreeContext | null,
): EnvironmentSelection | null => {
  if (override !== undefined)
    return Object.freeze({ source: "override", value: override });
  if (context?.environmentId !== undefined)
    return Object.freeze({ source: "worktree", value: context.environmentId });
  return null;
};

const parseGitHubRemote = (
  remote: GitRemote,
): Readonly<{ owner: string; name: string }> | null => {
  let path: string;
  if (remote.url.startsWith("git@github.com:"))
    path = remote.url.slice("git@github.com:".length);
  else {
    let url: URL;
    try {
      url = new URL(remote.url);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase() !== "github.com") return null;
    path = url.pathname;
  }
  const parts = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], name: parts[1] };
};

export const detectGitHubRepository = (
  remotes: readonly GitRemote[],
): GitHubRepository => {
  const matches = remotes.flatMap((remote) => {
    const parsed = parseGitHubRemote(remote);
    return parsed ? [{ remote, ...parsed }] : [];
  });
  if (matches.length === 0)
    throw new CliError(
      "invocation",
      "no GitHub repository remote was found",
      {},
      "repository_missing",
    );
  const identities = new Set(
    matches.map(
      ({ owner, name }) => `${owner.toLowerCase()}/${name.toLowerCase()}`,
    ),
  );
  if (identities.size !== 1)
    throw new CliError(
      "invocation",
      "GitHub repository remotes are ambiguous; choose one explicitly",
      {},
      "repository_ambiguous",
    );
  const first = matches[0];
  if (!first)
    throw new CliError(
      "invocation",
      "no GitHub repository remote was found",
      {},
      "repository_missing",
    );
  return Object.freeze({
    host: "github.com",
    owner: first.owner,
    name: first.name,
    remoteNames: Object.freeze(matches.map(({ remote }) => remote.name)),
  });
};

const validateContext = (value: unknown): WorktreeContext => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CliInvocationError("worktree context is invalid");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (
    !keys.every((key) =>
      ["environmentId", "projectId", "serverProfileId"].includes(key),
    ) ||
    !keys.includes("projectId") ||
    !keys.includes("serverProfileId")
  )
    throw new CliInvocationError(
      "worktree context must contain only opaque ids",
    );
  if (
    keys.some(
      (key) =>
        typeof object[key] !== "string" ||
        !opaqueId.test(object[key] as string),
    )
  )
    throw new CliInvocationError(
      "worktree context contains an invalid opaque id",
    );
  return Object.freeze({
    serverProfileId: object.serverProfileId as string,
    projectId: object.projectId as string,
    ...(object.environmentId === undefined
      ? {}
      : { environmentId: object.environmentId as string }),
  });
};

export const writeWorktreeContext = async (
  path: string,
  context: WorktreeContext,
): Promise<void> => {
  const valid = validateContext(context);
  try {
    await atomicWriteProtectedFile(path, `${JSON.stringify(valid)}\n`);
  } catch {
    throw new CliError(
      "local-io",
      "could not write worktree context",
      {},
      "context_write_failed",
    );
  }
};

export const readWorktreeContext = async (
  path: string,
): Promise<WorktreeContext | null> => {
  try {
    const source = await readFile(path, "utf8");
    return validateContext(JSON.parse(source) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof CliInvocationError) throw error;
    throw new CliError(
      "local-io",
      "could not read worktree context",
      {},
      "context_read_failed",
    );
  }
};

export const worktreeConfigPath = (gitDirectory: string): string =>
  join(gitDirectory, "dotrelay", "config");
