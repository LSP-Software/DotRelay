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
