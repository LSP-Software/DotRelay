import {
  BROWSER_DEVICE_ID_HEADER,
  e2eWorkspaceBoundary,
  emptyWorkspaceBoundary,
  parsePeerDevices,
  parseWorkspaceCatalog,
  resolveLiveApiOrigin,
  type WorkspaceBoundary,
  type WorkspaceProfileId,
  workspaceProfileCatalog,
} from "@/lib/workspace-boundary";

const isProfileId = (value: string | null): value is WorkspaceProfileId =>
  value === "hosted" || value === "self-hosted";

const fetchLiveBoundary = async (
  profileId: WorkspaceProfileId,
  request: Request,
  apiOrigin: string | undefined,
): Promise<WorkspaceBoundary> => {
  if (!apiOrigin) return emptyWorkspaceBoundary(profileId);
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
  if (!sessionResponse)
    return emptyWorkspaceBoundary(profileId, { origin: apiOrigin });
  const sessionActive = sessionResponse.ok;
  const sessionBody = sessionActive
    ? ((await sessionResponse.json().catch(() => undefined)) as
        | {
            user?: { id?: string; name?: string };
          }
        | undefined)
    : undefined;
  const session: WorkspaceBoundary["session"] = {
    active: sessionActive,
    ...(sessionBody?.user?.name ? { displayName: sessionBody.user.name } : {}),
    ...(sessionBody?.user?.id ? { userId: sessionBody.user.id } : {}),
  };
  const capabilitiesResponse = await fetch(`${apiOrigin}/api/v1/capabilities`, {
    cache: "no-store",
  }).catch(() => undefined);
  const capabilities = capabilitiesResponse?.ok
    ? ((await capabilitiesResponse.json().catch(() => undefined)) as
        | {
            serverProfileId?: unknown;
          }
        | undefined)
    : undefined;
  const profileWithServerProfile: WorkspaceBoundary["profile"] = {
    id: profileId,
    ...profile,
    origin: apiOrigin,
    ...(typeof capabilities?.serverProfileId === "string"
      ? { serverProfileId: capabilities.serverProfileId }
      : {}),
  };
  const environmentId = new URL(request.url).searchParams.get("environment");
  const workspaceUrl = new URL(`${apiOrigin}/api/v1/workspace/boundary`);
  if (environmentId)
    workspaceUrl.searchParams.set("environment", environmentId);
  const workspaceResponse = await fetch(workspaceUrl, {
    headers: apiHeaders,
    cache: "no-store",
  }).catch(() => undefined);
  const workspaceBody = workspaceResponse?.ok
    ? ((await workspaceResponse.json().catch(() => undefined)) as
        | {
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
          }
        | undefined)
    : undefined;
  if (!workspaceBody) {
    return {
      ...emptyWorkspaceBoundary(profileId, {
        origin: apiOrigin,
        session,
        connection: "online",
      }),
      profile: profileWithServerProfile,
    };
  }
  const headRevision =
    typeof workspaceBody.environment?.headRevision === "string"
      ? workspaceBody.environment.headRevision
      : "unknown";
  const deviceActive = workspaceBody.device?.active === true;
  return {
    source: "live",
    connection: "online",
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
    session,
    profile: profileWithServerProfile,
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
  const apiOrigin = resolveLiveApiOrigin();
  const environmentParam = url.searchParams.get("environment");
  const boundary =
    process.env.DOTRELAY_WORKSPACE_FIXTURE === "1"
      ? e2eWorkspaceBoundary(
          profileId,
          environmentParam ? { environmentId: environmentParam } : {},
        )
      : await fetchLiveBoundary(profileId, request, apiOrigin);
  const localBoundary =
    boundary.source === "fixture" && apiOrigin
      ? {
          ...boundary,
          profile: { ...boundary.profile, origin: apiOrigin },
        }
      : boundary;
  return Response.json(localBoundary satisfies WorkspaceBoundary, {
    headers: { "Cache-Control": "no-store" },
  });
};
