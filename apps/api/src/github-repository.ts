import { decryptOAuthToken } from "better-auth/oauth2";
import type { DotRelayAuth } from "./auth";

export type GitHubRepositoryDisplay = Readonly<{
  readonly owner: string;
  readonly name: string;
}>;

const cache = new Map<string, GitHubRepositoryDisplay>();

export const parseGitHubRepositoryDisplay = (
  body: unknown,
): GitHubRepositoryDisplay | undefined => {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.full_name === "string") {
    const separator = record.full_name.indexOf("/");
    if (separator > 0 && separator < record.full_name.length - 1) {
      return {
        owner: record.full_name.slice(0, separator),
        name: record.full_name.slice(separator + 1),
      };
    }
  }
  const ownerRecord =
    record.owner !== null &&
    typeof record.owner === "object" &&
    !Array.isArray(record.owner)
      ? (record.owner as Record<string, unknown>)
      : undefined;
  const owner =
    typeof ownerRecord?.login === "string" ? ownerRecord.login : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  if (!owner || !name) return undefined;
  return { owner, name };
};

export const lookupGitHubRepositoryDisplay = async (
  githubRepositoryId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubRepositoryDisplay | undefined> => {
  const cached = cache.get(githubRepositoryId);
  if (cached) return cached;
  if (!/^[1-9][0-9]{0,18}$/.test(githubRepositoryId)) return undefined;
  const response = await fetchImpl(
    `https://api.github.com/repositories/${githubRepositoryId}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "DotRelay",
      },
      cache: "no-store",
    },
  ).catch(() => undefined);
  if (!response?.ok) return undefined;
  const display = parseGitHubRepositoryDisplay(
    await response.json().catch(() => null),
  );
  if (display) cache.set(githubRepositoryId, display);
  return display;
};

// Every outbound GitHub call the Server Profile makes passes through this
// module. Identity resolution uses the acting User's Delegated GitHub Access
// — the fine-grained GitHub App grant stored when they signed in — never a
// service-wide credential and never an anonymous lookup.

export type GitHubIdentityResolution = Readonly<{
  readonly code: "resolved";
  readonly githubRepositoryId: string;
  /** The repository's current descriptive owner, from GitHub's answer. */
  readonly owner: string;
  /** The repository's current descriptive name, from GitHub's answer. */
  readonly name: string;
}>;

export type GitHubIdentityFailure =
  | Readonly<{ readonly code: "repository_access_denied" }>
  | Readonly<{
      readonly code: "github_rate_limited";
      readonly retryAfterSeconds?: number;
    }>
  | Readonly<{ readonly code: "github_unavailable" }>;

export type GitHubIdentityOutcome =
  | GitHubIdentityResolution
  | GitHubIdentityFailure;

export type GitHubIdentityOptions = Readonly<{
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}>;

const RESOLVE_DEADLINE_MS = 30_000;
const RESOLVE_MAX_ATTEMPTS = 3;
const RESOLVE_RETRY_BASE_DELAY_MS = 500;
const RESOLVE_RETRY_MAX_DELAY_MS = 5_000;
const MAX_RETRY_AFTER_SECONDS = 3_600;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const parseRetryAfterSeconds = (
  header: string | null,
  now: () => number,
): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(seconds));
  const date = Date.parse(header);
  if (!Number.isNaN(date))
    return Math.max(
      0,
      Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil((date - now()) / 1000)),
    );
  return undefined;
};

// GitHub's x-ratelimit-reset header names the epoch second the primary rate
// limit window resets; it is the retry window when no Retry-After is sent.
const parseRateResetSeconds = (
  header: string | null,
  now: () => number,
): number | undefined => {
  if (!header) return undefined;
  const epochSeconds = Number(header);
  if (!Number.isFinite(epochSeconds)) return undefined;
  return Math.max(
    0,
    Math.min(MAX_RETRY_AFTER_SECONDS, Math.round(epochSeconds - now() / 1000)),
  );
};

const parseGitHubRepositoryIdentity = (
  body: unknown,
): Readonly<{
  readonly githubRepositoryId: string;
  readonly owner: string;
  readonly name: string;
}> | null => {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return null;
  const record = body as Record<string, unknown>;
  if (
    typeof record.id !== "number" ||
    !Number.isSafeInteger(record.id) ||
    record.id < 1
  )
    return null;
  const display = parseGitHubRepositoryDisplay(record);
  if (!display) return null;
  return {
    githubRepositoryId: String(record.id),
    owner: display.owner,
    name: display.name,
  };
};

const delegatedGitHubAccessToken = async (
  auth: DotRelayAuth,
  userId: string,
): Promise<string | null> => {
  const context = await auth.$context;
  const accounts = await context.internalAdapter.findAccounts(userId);
  const account = accounts.find(
    (candidate) => candidate.providerId === "github",
  );
  const stored = account?.accessToken;
  if (typeof stored !== "string" || stored.length === 0) return null;
  const token = await decryptOAuthToken(stored, context as never);
  if (typeof token !== "string" || token.trim().length === 0) return null;
  return token;
};

const timedFetch = async (
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  deadlineMs: number,
): Promise<Response | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return await fetcher(url, {
      method: "GET",
      redirect: "error",
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/** `userId` is the acting user's better-auth user ID (authSubject); the
 *  stored Delegated GitHub Access is keyed by it, not by the DotRelay User
 *  table's ID. */
export const resolveGitHubRepositoryIdentity = async (
  auth: DotRelayAuth,
  userId: string,
  repository: Readonly<{ readonly owner: string; readonly name: string }>,
  options: GitHubIdentityOptions = {},
): Promise<GitHubIdentityOutcome> => {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const token = await delegatedGitHubAccessToken(auth, userId);
  // No Delegated GitHub Access for this User: the user-to-server grant was
  // never made or was revoked, so no repository can be resolved for them.
  if (token === null) return { code: "repository_access_denied" };
  const url = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "DotRelay",
    Authorization: `Bearer ${token}`,
  };
  const startedAt = now();
  const deadlineAt = startedAt + RESOLVE_DEADLINE_MS;
  for (let attempt = 1; attempt <= RESOLVE_MAX_ATTEMPTS; attempt += 1) {
    const response = await timedFetch(
      fetcher,
      url,
      headers,
      Math.max(1, Math.min(RESOLVE_DEADLINE_MS, deadlineAt - now())),
    );
    if (response === undefined) {
      // GitHub could not be reached at all: retry within the budget, then
      // report the outage; an established Repository Linkage is unaffected.
      if (attempt < RESOLVE_MAX_ATTEMPTS && now() < deadlineAt) {
        await sleep(
          Math.min(
            RESOLVE_RETRY_MAX_DELAY_MS,
            RESOLVE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          ),
        );
        continue;
      }
      return { code: "github_unavailable" };
    }
    if (response.ok) {
      const identity = parseGitHubRepositoryIdentity(
        await response.json().catch(() => null),
      );
      // A 200 with an unusable payload is not a definitive access verdict.
      if (identity) return { code: "resolved", ...identity };
      return { code: "github_unavailable" };
    }
    // 403 and 404 are conflated on purpose: the endpoint is not an
    // existence oracle, so absence and denial answer identically.
    if (response.status === 403 || response.status === 404)
      return { code: "repository_access_denied" };
    const transient = response.status === 429 || response.status >= 500;
    if (transient && attempt < RESOLVE_MAX_ATTEMPTS && now() < deadlineAt) {
      const retryAfterHeader =
        response.headers.get("Retry-After") ??
        response.headers.get("X-Retry-After");
      const retryAfterMs =
        parseRetryAfterSeconds(retryAfterHeader, now) !== undefined
          ? (parseRetryAfterSeconds(retryAfterHeader, now) as number) * 1000
          : Math.min(
              RESOLVE_RETRY_MAX_DELAY_MS,
              RESOLVE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
            );
      await sleep(Math.min(retryAfterMs, Math.max(0, deadlineAt - now())));
      continue;
    }
    if (response.status === 429) {
      const retryAfterSeconds =
        parseRetryAfterSeconds(
          response.headers.get("Retry-After") ??
            response.headers.get("X-Retry-After"),
          now,
        ) ??
        parseRateResetSeconds(response.headers.get("x-ratelimit-reset"), now);
      return {
        code: "github_rate_limited",
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }
    return { code: "github_unavailable" };
  }
  return { code: "github_unavailable" };
};
