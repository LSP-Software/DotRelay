import { decryptOAuthToken } from "better-auth/oauth2";
import type { DotRelayAuth } from "./auth";

// Companion seam to the repository-resolution seam in github-repository.ts.
// Outbound GitHub calls that identify a person — never a repository — pass
// through this module, and, like repository resolution, they act on the
// acting User's behalf through their Delegated GitHub Access. A Membership
// Invitation addresses the resolved stable GitHub subject, never the mutable
// login or an email address.

export type GitHubUserIdentityResolution = Readonly<{
  readonly code: "resolved";
  readonly githubUserId: string;
  readonly login: string;
}>;

export type GitHubUserIdentityFailure =
  | Readonly<{ readonly code: "github_access_denied" }>
  | Readonly<{ readonly code: "github_identity_not_found" }>
  | Readonly<{
      readonly code: "github_rate_limited";
      readonly retryAfterSeconds?: number;
    }>
  | Readonly<{ readonly code: "github_unavailable" }>;

export type GitHubUserIdentityOutcome =
  | GitHubUserIdentityResolution
  | GitHubUserIdentityFailure;

export type GitHubUserIdentityOptions = Readonly<{
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}>;

// GitHub limits user logins to 1 to 39 characters of letters, digits, and
// hyphens, and a login cannot begin or end with a hyphen.
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export const isValidGitHubLogin = (login: string): boolean =>
  GITHUB_LOGIN_PATTERN.test(login);

const USER_DEADLINE_MS = 30_000;
const USER_MAX_ATTEMPTS = 3;
const USER_RETRY_BASE_DELAY_MS = 500;
const USER_RETRY_MAX_DELAY_MS = 5_000;
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

const parseGitHubUserIdentity = (
  body: unknown,
): Readonly<{
  readonly githubUserId: string;
  readonly login: string;
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
  if (typeof record.login !== "string") return null;
  return { githubUserId: String(record.id), login: record.login };
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
export const resolveGitHubUserIdentity = async (
  auth: DotRelayAuth,
  userId: string,
  login: string,
  options: GitHubUserIdentityOptions = {},
): Promise<GitHubUserIdentityOutcome> => {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  if (!isValidGitHubLogin(login)) return { code: "github_identity_not_found" };
  const token = await delegatedGitHubAccessToken(auth, userId);
  // No Delegated GitHub Access for this User: the user-to-server grant was
  // never made or was revoked, so nothing can be resolved for them.
  if (token === null) return { code: "github_access_denied" };
  const url = `https://api.github.com/users/${encodeURIComponent(login)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "DotRelay",
    Authorization: `Bearer ${token}`,
  };
  const startedAt = now();
  const deadlineAt = startedAt + USER_DEADLINE_MS;
  for (let attempt = 1; attempt <= USER_MAX_ATTEMPTS; attempt += 1) {
    const response = await timedFetch(
      fetcher,
      url,
      headers,
      Math.max(1, Math.min(USER_DEADLINE_MS, deadlineAt - now())),
    );
    if (response === undefined) {
      // GitHub could not be reached at all: retry within the budget, then
      // report the outage.
      if (attempt < USER_MAX_ATTEMPTS && now() < deadlineAt) {
        await sleep(
          Math.min(
            USER_RETRY_MAX_DELAY_MS,
            USER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          ),
        );
        continue;
      }
      return { code: "github_unavailable" };
    }
    if (response.ok) {
      const identity = parseGitHubUserIdentity(
        await response.json().catch(() => null),
      );
      // A 200 with an unusable payload is not a definitive identity verdict.
      if (identity) return { code: "resolved", ...identity };
      return { code: "github_unavailable" };
    }
    // 403 and 404 are conflated on purpose: the endpoint is not an
    // existence oracle, so absence and denial answer identically. A 403
    // that carries GitHub's rate-limit signals (a Retry-After, or an
    // exhausted x-ratelimit-remaining) is a secondary rate limit, and
    // answering it "not found" would send the owner to retype the login
    // instead of waiting out the window.
    // 401 answers the credential, not GitHub: an expired or revoked Delegated
    // GitHub Access must be reported as a denial the User can repair by
    // re-authorizing, never as an outage no retry will cure.
    if (response.status === 401) return { code: "github_access_denied" };
    const retryAfterHeader =
      response.headers.get("Retry-After") ??
      response.headers.get("X-Retry-After");
    const secondaryRateLimited =
      response.status === 403 &&
      (retryAfterHeader !== null ||
        response.headers.get("x-ratelimit-remaining") === "0");
    if (
      (response.status === 403 && !secondaryRateLimited) ||
      response.status === 404
    )
      return { code: "github_identity_not_found" };
    const transient =
      secondaryRateLimited || response.status === 429 || response.status >= 500;
    if (transient && attempt < USER_MAX_ATTEMPTS && now() < deadlineAt) {
      const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader, now);
      const retryAfterMs =
        retryAfterSeconds !== undefined
          ? retryAfterSeconds * 1000
          : Math.min(
              USER_RETRY_MAX_DELAY_MS,
              USER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
            );
      await sleep(Math.min(retryAfterMs, Math.max(0, deadlineAt - now())));
      continue;
    }
    if (secondaryRateLimited || response.status === 429) {
      const retryAfterSeconds =
        parseRetryAfterSeconds(retryAfterHeader, now) ??
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
