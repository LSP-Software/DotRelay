import { isAlphaAdmissionResponse } from "@/lib/alpha-admission";

export type ServerSessionState =
  "signed-in" | "signed-out" | "not-admitted" | "unknown";

// Server-side read of the visitor's session, used by the public pages. Only
// a 200 from the API's session relay proves a session and only a 401 proves
// its absence; alpha_admission_required means signed in but not on the alpha
// list. An unreachable or undeployed relay reads as unknown, so a degraded
// API never moves a visitor off the public pages.
export const readServerSession = async (
  input: Readonly<{
    readonly apiOrigin: string | undefined;
    readonly cookie: string | null;
    readonly fetcher?: typeof fetch;
  }>,
): Promise<ServerSessionState> => {
  if (!input.apiOrigin) return "unknown";
  if (!input.cookie) return "signed-out";
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(`${input.apiOrigin}/api/v1/session`, {
    headers: { cookie: input.cookie },
    cache: "no-store",
  }).catch(() => undefined);
  if (!response) return "unknown";
  if (response.status === 200) return "signed-in";
  if (response.status === 401) return "signed-out";
  if (await isAlphaAdmissionResponse(response)) return "not-admitted";
  return "unknown";
};

export const isSessionActive = async (
  input: Parameters<typeof readServerSession>[0],
): Promise<boolean> => (await readServerSession(input)) === "signed-in";
