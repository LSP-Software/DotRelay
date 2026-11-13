// Server-side check for a signed-in visitor, used by the public pages. Only
// a 200 from the API's session relay proves a session; a signed-out,
// unreachable, or undeployed relay all read as signed out, so a degraded API
// never moves a visitor off the public pages.
export const isSessionActive = async (
  input: Readonly<{
    readonly apiOrigin: string | undefined;
    readonly cookie: string | null;
    readonly fetcher?: typeof fetch;
  }>,
): Promise<boolean> => {
  if (!input.apiOrigin || !input.cookie) return false;
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(`${input.apiOrigin}/api/v1/session`, {
    headers: { cookie: input.cookie },
    cache: "no-store",
  }).catch(() => undefined);
  return response?.status === 200;
};
