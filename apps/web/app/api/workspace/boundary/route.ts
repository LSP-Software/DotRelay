import {
  e2eWorkspaceBoundary,
  type WorkspaceBoundary,
  type WorkspaceProfileId,
  workspaceProfileCatalog,
} from "@/lib/workspace-boundary";

const isProfileId = (value: string | null): value is WorkspaceProfileId =>
  value === "hosted" || value === "self-hosted";

const resolveApiOrigin = (): string | undefined =>
  process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN ??
  process.env.DOTRELAY_API_ORIGIN;

const fetchLiveBoundary = async (
  profileId: WorkspaceProfileId,
  request: Request,
): Promise<WorkspaceBoundary | undefined> => {
  if (process.env.DOTRELAY_LIVE_BOUNDARY !== "1") return undefined;
  const apiOrigin = resolveApiOrigin();
  if (!apiOrigin) return undefined;
  const profile = workspaceProfileCatalog[profileId];
  const cookie = request.headers.get("cookie");
  const sessionResponse = await fetch(`${apiOrigin}/api/v1/session`, {
    headers: cookie ? { cookie } : {},
    cache: "no-store",
  }).catch(() => undefined);
  if (!sessionResponse) return undefined;
  const sessionActive = sessionResponse.ok;
  const sessionBody = sessionActive
    ? ((await sessionResponse.json()) as { user?: { name?: string } })
    : undefined;
  const capabilitiesResponse = await fetch(`${apiOrigin}/api/v1/capabilities`, {
    cache: "no-store",
  }).catch(() => undefined);
  if (!capabilitiesResponse?.ok) return undefined;
  const cryptoAvailable =
    typeof globalThis.crypto?.subtle?.importKey === "function";
  return {
    session: {
      active: sessionActive,
      ...(sessionBody?.user?.name
        ? { displayName: sessionBody.user.name }
        : {}),
    },
    profile: { id: profileId, ...profile },
    device: { active: false, label: "No active Device" },
    grantsReady: false,
    epochCurrent: true,
    rotationRequired: false,
    crypto: cryptoAvailable
      ? { available: true }
      : {
          available: false,
          problemCode: "crypto_provider_unavailable",
        },
  };
};

export const GET = async (request: Request) => {
  const url = new URL(request.url);
  const profileParam = url.searchParams.get("profile");
  const profileId = isProfileId(profileParam) ? profileParam : "hosted";
  const liveBoundary = await fetchLiveBoundary(profileId, request);
  const boundary = liveBoundary ?? e2eWorkspaceBoundary(profileId);
  return Response.json(boundary satisfies WorkspaceBoundary, {
    headers: { "Cache-Control": "no-store" },
  });
};
