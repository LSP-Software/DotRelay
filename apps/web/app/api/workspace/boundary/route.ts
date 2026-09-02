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
    ? ((await sessionResponse.json()) as {
        user?: { id?: string; name?: string };
      })
    : undefined;
  const capabilitiesResponse = await fetch(`${apiOrigin}/api/v1/capabilities`, {
    cache: "no-store",
  }).catch(() => undefined);
  if (!capabilitiesResponse?.ok) return undefined;
  const capabilities = (await capabilitiesResponse.json()) as {
    serverProfileId?: unknown;
  };
  const workspaceResponse = await fetch(
    `${apiOrigin}/api/v1/workspace/boundary`,
    {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
    },
  ).catch(() => undefined);
  if (!workspaceResponse?.ok) return undefined;
  const workspaceBody = (await workspaceResponse.json()) as {
    environment?: {
      headRevision?: unknown;
      id?: unknown;
      projectId?: unknown;
      teamId?: unknown;
      headHash?: unknown;
      projectEpoch?: unknown;
    };
    device?: {
      id?: unknown;
      active?: unknown;
      label?: unknown;
      encryptionPublicKey?: unknown;
      signingPublicKey?: unknown;
    };
    grantsReady?: unknown;
    epochCurrent?: unknown;
    rotationRequired?: unknown;
    projectEpoch?: unknown;
  };
  const headRevision =
    typeof workspaceBody.environment?.headRevision === "string"
      ? workspaceBody.environment.headRevision
      : "unknown";
  const deviceActive = workspaceBody.device?.active === true;
  const cryptoAvailable =
    typeof globalThis.crypto?.subtle?.importKey === "function";
  return {
    environment: {
      headRevision,
      ...(typeof workspaceBody.environment?.id === "string"
        ? { id: workspaceBody.environment.id }
        : {}),
      ...(typeof workspaceBody.environment?.projectId === "string"
        ? { projectId: workspaceBody.environment.projectId }
        : {}),
      ...(typeof workspaceBody.environment?.teamId === "string"
        ? { teamId: workspaceBody.environment.teamId }
        : {}),
      ...(typeof workspaceBody.environment?.headHash === "string" ||
      workspaceBody.environment?.headHash === null
        ? { headHash: workspaceBody.environment.headHash }
        : {}),
      ...(typeof workspaceBody.environment?.projectEpoch === "string"
        ? { projectEpoch: workspaceBody.environment.projectEpoch }
        : {}),
    },
    session: {
      active: sessionActive,
      ...(sessionBody?.user?.name
        ? { displayName: sessionBody.user.name }
        : {}),
      ...(sessionBody?.user?.id ? { userId: sessionBody.user.id } : {}),
    },
    profile: {
      id: profileId,
      ...profile,
      ...(typeof capabilities.serverProfileId === "string"
        ? { serverProfileId: capabilities.serverProfileId }
        : {}),
      origin: apiOrigin,
    },
    device: {
      active: deviceActive,
      label:
        typeof workspaceBody.device?.label === "string"
          ? workspaceBody.device.label
          : "No active Device",
      ...(typeof workspaceBody.device?.id === "string"
        ? { id: workspaceBody.device.id }
        : {}),
      ...(typeof workspaceBody.device?.encryptionPublicKey === "string"
        ? { encryptionPublicKey: workspaceBody.device.encryptionPublicKey }
        : {}),
      ...(typeof workspaceBody.device?.signingPublicKey === "string"
        ? { signingPublicKey: workspaceBody.device.signingPublicKey }
        : {}),
    },
    grantsReady: workspaceBody.grantsReady === true,
    epochCurrent: workspaceBody.epochCurrent === true,
    rotationRequired: workspaceBody.rotationRequired === true,
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
