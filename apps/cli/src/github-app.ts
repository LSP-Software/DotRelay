import { parseGitHubAppDocument } from "@dotrelay/contracts";
import {
  CliError,
  problemCodeFor,
  repositoryAccessDeniedDetail,
} from "./errors";
import {
  fetchWithDeadline,
  type NetworkPolicy,
  probeNetworkPolicy,
} from "./network";
import type { FetchFunction, ProfileCatalogStore } from "./profile";

/**
 * Asks the Server Profile where to install its GitHub App. Older servers and
 * servers without `GITHUB_APP_SLUG` answer 404; any failure means no link.
 */
export const fetchGitHubAppInstallUrl = async (
  origin: string,
  options: Readonly<{
    readonly fetch?: FetchFunction;
    readonly networkPolicy?: NetworkPolicy;
  }> = {},
): Promise<string | undefined> => {
  const policy = options.networkPolicy ?? probeNetworkPolicy;
  // fetchWithDeadline stops timing once headers arrive. This deadline also
  // covers the body, so a stalled body cannot delay the original error.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, policy.requestDeadlineMs);
  });
  const lookup = (async () => {
    const response = await fetchWithDeadline(
      options.fetch ?? fetch,
      `${origin}/api/v1/github-app`,
      {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
      policy,
    );
    if (!response.ok) return undefined;
    return parseGitHubAppDocument(await response.json()).installUrl;
  })().catch(() => undefined);
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Adds the server's GitHub App install link to a repository access denial.
 * Other errors pass through unchanged.
 */
export const withGitHubAppInstallHint = async (
  error: unknown,
  options: Readonly<{
    readonly store: ProfileCatalogStore;
    readonly profileName?: string;
    readonly defaultOrigin?: string;
    readonly fetch?: FetchFunction;
    readonly networkPolicy?: NetworkPolicy;
  }>,
): Promise<unknown> => {
  const code = error instanceof CliError ? error.code : problemCodeFor(error);
  if (code !== "repository_access_denied") return error;
  const catalog = await options.store.read().catch(() => undefined);
  const name = options.profileName ?? catalog?.selected;
  const origin =
    name === undefined
      ? options.defaultOrigin
      : catalog?.profiles.find((profile) => profile.name === name)?.origin;
  const installUrl = origin
    ? await fetchGitHubAppInstallUrl(origin, options)
    : undefined;
  return new CliError(
    "authentication",
    repositoryAccessDeniedDetail(installUrl),
    {},
    "repository_access_denied",
  );
};
