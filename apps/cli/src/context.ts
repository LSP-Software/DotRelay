import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError, CliInvocationError } from "./errors";
import { atomicWriteProtectedFile } from "./output";
import type { FetchFunction } from "./profile";
import type { TerminalIo } from "./terminal";
import { selectOption } from "./ui";

export type GitRemote = Readonly<{
  readonly name: string;
  readonly url: string;
}>;
export type GitHubRepository = Readonly<{
  readonly host: "github.com";
  readonly owner: string;
  readonly name: string;
  readonly remoteNames: readonly string[];
  readonly githubRepositoryId?: string;
}>;

export type RepositoryChoice = Readonly<{
  readonly remote: string;
  readonly owner: string;
  readonly name: string;
}>;

export type GitHubRepositorySelection = Readonly<{
  readonly repository: GitHubRepository;
  readonly remoteName: string;
  readonly source: "detected" | "saved" | "override" | "interactive";
  readonly choice: RepositoryChoice;
}>;

export type WorktreeContext = Readonly<{
  readonly serverProfileId?: string;
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly repositoryRemote?: string;
  readonly repositoryOwner?: string;
  readonly repositoryName?: string;
}>;

export type EnvironmentSelection = Readonly<{
  readonly source: "override" | "worktree";
  readonly value: string;
}>;

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
// Remote names and GitHub owner/name parts are stored as identifiers; they
// are short, never carry credentials, and cannot encode a URL.
const repositoryIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const contextKeys = new Set([
  "environmentId",
  "projectId",
  "repositoryName",
  "repositoryOwner",
  "repositoryRemote",
  "serverProfileId",
]);
const repositoryChoiceKeys = new Set([
  "repositoryName",
  "repositoryOwner",
  "repositoryRemote",
]);

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

type GitRemoteMatch = Readonly<{
  readonly remote: GitRemote;
  readonly owner: string;
  readonly name: string;
}>;

const listGitHubRemoteMatches = (
  remotes: readonly GitRemote[],
): readonly GitRemoteMatch[] =>
  Object.freeze(
    remotes.flatMap((remote) => {
      const parsed = parseGitHubRemote(remote);
      return parsed ? [Object.freeze({ remote, ...parsed })] : [];
    }),
  );

const sameGitHubIdentity = (
  left: Readonly<{ readonly owner: string; readonly name: string }>,
  right: Readonly<{ readonly owner: string; readonly name: string }>,
): boolean =>
  left.owner.toLowerCase() === right.owner.toLowerCase() &&
  left.name.toLowerCase() === right.name.toLowerCase();

const repositoryMissing = (): CliError =>
  new CliError(
    "invocation",
    "no GitHub repository remote was found",
    {},
    "repository_missing",
  );

// The saved and overridden forms are explicit choices the operator made; the
// detected form is an unambiguous read of the Git configuration and is never
// persisted, so the worktree context records only explicit choices.
export const selectGitHubRepository = async (
  remotes: readonly GitRemote[],
  options: Readonly<{
    readonly remoteName?: string;
    readonly saved?: RepositoryChoice | null;
    readonly noInput?: boolean;
    readonly prompt?: (question: string) => Promise<string>;
    readonly terminal?: TerminalIo;
  }> = {},
): Promise<GitHubRepositorySelection> => {
  const matches = listGitHubRemoteMatches(remotes);
  if (matches.length === 0) throw repositoryMissing();
  const choose = (
    match: GitRemoteMatch,
    source: GitHubRepositorySelection["source"],
  ): GitHubRepositorySelection => {
    const repository: GitHubRepository = Object.freeze({
      host: "github.com",
      owner: match.owner,
      name: match.name,
      remoteNames: Object.freeze(
        matches
          .filter((peer) => sameGitHubIdentity(peer, match))
          .map(({ remote }) => remote.name),
      ),
    });
    const choice: RepositoryChoice = Object.freeze({
      remote: match.remote.name,
      owner: match.owner,
      name: match.name,
    });
    return Object.freeze({
      repository,
      remoteName: match.remote.name,
      source,
      choice,
    });
  };
  if (options.remoteName !== undefined) {
    const remoteName = options.remoteName;
    const match = matches.find((entry) => entry.remote.name === remoteName);
    if (match) return choose(match, "override");
    // A known remote that is not a GitHub remote is a different kind of
    // misconfiguration than a typo; name which one applies.
    const known = remotes.some((remote) => remote.name === remoteName);
    throw new CliInvocationError(
      known
        ? `the specified remote is not a GitHub remote`
        : `the specified remote was not found`,
    );
  }
  const saved = options.saved;
  let choiceDiscarded = false;
  if (saved) {
    const match = matches.find(
      (entry) =>
        entry.remote.name === saved.remote && sameGitHubIdentity(entry, saved),
    );
    // The choice is pinned to a remote that still points at the same
    // repository; a removed or repointed remote discards it, so neither the
    // unambiguous-detection shortcut nor a silent re-resolution may follow
    // the remotes somewhere the operator did not choose.
    if (match) return choose(match, "saved");
    choiceDiscarded = true;
  }
  const identities = new Set(
    matches.map(
      ({ owner, name }) => `${owner.toLowerCase()}/${name.toLowerCase()}`,
    ),
  );
  if (identities.size === 1 && !choiceDiscarded) {
    const first = matches[0];
    if (!first) throw repositoryMissing();
    return choose(first, "detected");
  }
  if (options.noInput)
    throw new CliError(
      "invocation",
      `${
        identities.size === 1 && choiceDiscarded
          ? "the recorded repository choice no longer matches the Git remotes; "
          : "GitHub repository remotes are ambiguous; "
      }pass --remote <remote-name> with one of:\n${matches
        .map(
          ({ remote, owner, name }, index) =>
            `${index + 1}. ${remote.name} — ${owner}/${name}`,
        )
        .join("\n")}`,
      {},
      "repository_ambiguous",
    );
  // The listing shows remote names and repository names only; remote URLs
  // may carry credentials and are never shown or stored.
  const selectedId = await selectOption(
    "GitHub Repository",
    matches.map((match) => ({
      id: match.remote.name,
      label: `${match.remote.name} — ${match.owner}/${match.name}`,
    })),
    {
      ...(options.terminal ? { terminal: options.terminal } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
      defaultToFirst: false,
    },
  );
  const match = matches.find((entry) => entry.remote.name === selectedId);
  if (!match) throw new CliInvocationError("choose a remote from the list");
  return choose(match, "interactive");
};

export const detectGitHubRepository = (
  remotes: readonly GitRemote[],
): GitHubRepository => {
  const matches = listGitHubRemoteMatches(remotes);
  if (matches.length === 0) throw repositoryMissing();
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
  if (!first) throw repositoryMissing();
  return Object.freeze({
    host: "github.com",
    owner: first.owner,
    name: first.name,
    remoteNames: Object.freeze(matches.map(({ remote }) => remote.name)),
  });
};

export const repositoryChoiceFrom = (
  context: WorktreeContext | null,
): RepositoryChoice | null =>
  context?.repositoryRemote !== undefined &&
  context.repositoryOwner !== undefined &&
  context.repositoryName !== undefined
    ? Object.freeze({
        remote: context.repositoryRemote,
        owner: context.repositoryOwner,
        name: context.repositoryName,
      })
    : null;

export const repositoryChoiceFields = (
  choice: RepositoryChoice,
): Readonly<{
  readonly repositoryRemote: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
}> =>
  Object.freeze({
    repositoryRemote: choice.remote,
    repositoryOwner: choice.owner,
    repositoryName: choice.name,
  });

export const readStoredWorktreeContext = async (
  path: string,
): Promise<WorktreeContext | null> => {
  try {
    return await readWorktreeContext(path);
  } catch {
    // A damaged context is treated as absent: commands that only need the
    // recorded repository choice re-detect it and rewrite the file when they
    // succeed.
    return null;
  }
};

const readRepositoryId = async (response: Response): Promise<string> => {
  if (!response.ok)
    throw new CliError(
      "transient",
      "GitHub could not resolve the repository identity",
      {},
      "repository_resolution_failed",
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CliError(
      "transient",
      "GitHub returned an invalid repository identity",
      {},
      "repository_resolution_failed",
    );
  }
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).id !== "number" ||
    !Number.isSafeInteger((body as Record<string, unknown>).id) ||
    Number((body as Record<string, unknown>).id) < 1
  )
    throw new CliError(
      "transient",
      "GitHub returned an invalid repository identity",
      {},
      "repository_resolution_failed",
    );
  return String((body as Record<string, unknown>).id);
};

export const resolveGitHubRepository = async (
  repository: GitHubRepository,
  options: Readonly<{
    readonly fetch?: FetchFunction;
    readonly environment?: NodeJS.ProcessEnv;
  }> = {},
): Promise<GitHubRepository> => {
  if (repository.githubRepositoryId) return repository;
  const fetcher = options.fetch ?? fetch;
  const environment = options.environment ?? process.env;
  const githubToken = (environment.GITHUB_TOKEN ?? "").trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "dotrelay-cli",
  };
  if (githubToken.length > 0) headers.Authorization = `Bearer ${githubToken}`;
  let response: Response;
  try {
    response = await fetcher(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
      {
        method: "GET",
        redirect: "error",
        headers,
      },
    );
  } catch {
    throw new CliError(
      "transient",
      "could not resolve the GitHub repository identity",
      {},
      "repository_resolution_failed",
    );
  }
  return Object.freeze({
    ...repository,
    githubRepositoryId: await readRepositoryId(response),
  });
};

const validateContext = (value: unknown): WorktreeContext => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CliInvocationError("worktree context is invalid");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (!keys.length || !keys.every((key) => contextKeys.has(key)))
    throw new CliInvocationError(
      "worktree context must contain only opaque ids",
    );
  // The three repository identifiers are written as a unit; a partial
  // choice cannot be trusted to name one remote's identity.
  const choiceKeys = keys.filter((key) => repositoryChoiceKeys.has(key));
  if (choiceKeys.length !== 0 && choiceKeys.length !== 3)
    throw new CliInvocationError(
      "worktree context must contain only opaque ids",
    );
  // Before a Project is linked a worktree may hold only the explicit
  // repository choice; otherwise the profile and Project ids are required.
  if (
    choiceKeys.length !== 3 &&
    (!keys.includes("serverProfileId") || !keys.includes("projectId"))
  )
    throw new CliInvocationError(
      "worktree context must contain only opaque ids",
    );
  if (
    keys.some((key) => {
      const entry = object[key];
      if (typeof entry !== "string") return true;
      return repositoryChoiceKeys.has(key)
        ? !repositoryIdentifier.test(entry)
        : !opaqueId.test(entry);
    })
  )
    throw new CliInvocationError(
      "worktree context contains an invalid opaque id",
    );
  return Object.freeze({
    ...(object.serverProfileId === undefined
      ? {}
      : { serverProfileId: object.serverProfileId as string }),
    ...(object.projectId === undefined
      ? {}
      : { projectId: object.projectId as string }),
    ...(object.environmentId === undefined
      ? {}
      : { environmentId: object.environmentId as string }),
    ...(object.repositoryRemote === undefined
      ? {}
      : { repositoryRemote: object.repositoryRemote as string }),
    ...(object.repositoryOwner === undefined
      ? {}
      : { repositoryOwner: object.repositoryOwner as string }),
    ...(object.repositoryName === undefined
      ? {}
      : { repositoryName: object.repositoryName as string }),
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
