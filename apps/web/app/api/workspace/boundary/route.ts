import {
  BROWSER_DEVICE_ID_HEADER,
  e2eWorkspaceBoundary,
  parsePeerDevices,
  parseWorkspaceCatalog,
  resolveLiveApiOrigin,
  type WorkspaceBoundary,
  type WorkspaceProfileId,
  workspaceProfileCatalog,
} from "@/lib/workspace-boundary";

const isProfileId = (value: string | null): value is WorkspaceProfileId =>
  value === "hosted" || value === "self-hosted";

const emptyLiveBoundary = (
  profileId: WorkspaceProfileId,
  origin: string,
): WorkspaceBoundary => {
  const profile = workspaceProfileCatalog[profileId];
  return {
    source: "live",
    catalog: { teams: [], projects: [] },
    environment: { headRevision: "empty-environment" },
    session: { active: false },
    profile: { id: profileId, ...profile, origin },
    device: { active: false, label: "No active Device" },
    grantsReady: false,
    epochCurrent: false,
    rotationRequired: false,
    crypto: { available: true },
  };
};

const fetchLiveBoundary = async (
  profileId: WorkspaceProfileId,
  request: Request,
): Promise<WorkspaceBoundary | undefined> => {
  if (process.env.DOTRELAY_WORKSPACE_FIXTURE === "1") return undefined;
  const apiOrigin = resolveLiveApiOrigin();
  if (!apiOrigin) return undefined;
  const profile = workspaceProfileCatalog[profileId];
  const cookie = request.headers.get("cookie");
  const deviceId = request.headers.get(BROWSER_DEVICE_ID_HEADER);
  const apiHeaders = {
    ...(cookie ? { cookie } : {}),
    ...(deviceId ? { [BROWSER_DEVICE_ID_HEADER]: deviceId } : {}),
  };
  const sessionResponse = await fetch(`${apiOrigin}/api/v1/session`, {
    headers: apiHeaders,
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
  const capabilities = capabilitiesResponse?.ok
    ? ((await capabilitiesResponse.json()) as { serverProfileId?: unknown })
    : undefined;
  const environmentId = new URL(request.url).searchParams.get("environment");
  const workspaceUrl = new URL(`${apiOrigin}/api/v1/workspace/boundary`);
  if (environmentId)
    workspaceUrl.searchParams.set("environment", environmentId);
  const workspaceResponse = await fetch(workspaceUrl, {
    headers: apiHeaders,
    cache: "no-store",
  }).catch(() => undefined);
  if (!workspaceResponse?.ok)
    return {
      ...emptyLiveBoundary(profileId, apiOrigin),
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
        origin: apiOrigin,
        ...(typeof capabilities?.serverProfileId === "string"
          ? { serverProfileId: capabilities.serverProfileId }
          : {}),
      },
    };
  const workspaceBody = (await workspaceResponse.json()) as {
    environment?: {
      headRevision?: unknown;
      id?: unknown;
      label?: unknown;
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
    catalog?: unknown;
    signingTrustKeys?: unknown;
    epochGrant?: unknown;
    peerDevices?: unknown;
  };
  const headRevision =
    typeof workspaceBody.environment?.headRevision === "string"
      ? workspaceBody.environment.headRevision
      : "unknown";
  const deviceActive = workspaceBody.device?.active === true;
  return {
    source: "live",
    catalog: parseWorkspaceCatalog(workspaceBody.catalog),
    environment: {
      headRevision,
      ...(typeof workspaceBody.environment?.id === "string"
        ? { id: workspaceBody.environment.id }
        : {}),
      ...(typeof workspaceBody.environment?.label === "string"
        ? { label: workspaceBody.environment.label }
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
      ...(typeof capabilities?.serverProfileId === "string"
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
    ...(Array.isArray(workspaceBody.signingTrustKeys)
      ? {
          signingTrustKeys: workspaceBody.signingTrustKeys.filter(
            (key): key is string => typeof key === "string",
          ),
        }
      : {}),
    ...(typeof workspaceBody.epochGrant === "string"
      ? { epochGrant: workspaceBody.epochGrant }
      : {}),
    peerDevices: parsePeerDevices(workspaceBody.peerDevices),
    crypto: { available: true },
  };
};

export const GET = async (request: Request) => {
  const url = new URL(request.url);
  const profileParam = url.searchParams.get("profile");
  const profileId = isProfileId(profileParam) ? profileParam : "hosted";
  const liveBoundary = await fetchLiveBoundary(profileId, request);
  const boundary = liveBoundary ?? e2eWorkspaceBoundary(profileId);
  const apiOrigin = resolveLiveApiOrigin();
  const localBoundary =
    apiOrigin &&
    process.env.DOTRELAY_WORKSPACE_FIXTURE !== "1" &&
    boundary.source === "fixture"
      ? {
          ...boundary,
          profile: { ...boundary.profile, origin: apiOrigin },
        }
      : boundary;
  return Response.json(localBoundary satisfies WorkspaceBoundary, {
    headers: { "Cache-Control": "no-store" },
  });
};
