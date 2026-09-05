export type WorkspaceProfileId = "hosted" | "self-hosted";

export type WorkspaceBoundary = Readonly<{
  readonly environment: Readonly<{
    readonly headRevision: string;
    readonly id?: string;
    readonly projectId?: string;
    readonly teamId?: string;
    readonly headHash?: string | null;
    readonly projectEpoch?: string;
  }>;
  readonly session: Readonly<{
    readonly active: boolean;
    readonly userId?: string;
    readonly displayName?: string;
  }>;
  readonly profile: Readonly<{
    readonly id: WorkspaceProfileId;
    readonly name: string;
    readonly origin: string;
    readonly pinned: boolean;
    readonly serverProfileId?: string;
  }>;
  readonly device: Readonly<{
    readonly active: boolean;
    readonly label?: string;
    readonly id?: string;
    readonly encryptionPublicKey?: string;
    readonly signingPublicKey?: string;
  }>;
  readonly grantsReady: boolean;
  readonly epochCurrent: boolean;
  readonly rotationRequired: boolean;
  readonly crypto: Readonly<{
    readonly available: boolean;
    readonly problemCode?:
      | "crypto_provider_unavailable"
      | "unsupported_crypto_runtime";
  }>;
}>;

const profileCatalog: Readonly<
  Record<
    WorkspaceProfileId,
    Readonly<{ name: string; origin: string; pinned: boolean }>
  >
> = {
  hosted: {
    name: "Hosted / London",
    origin: "https://relay.dotrelay.dev",
    pinned: true,
  },
  "self-hosted": {
    name: "Self-hosted / eu-1",
    origin: "https://relay.acme.internal",
    pinned: false,
  },
};

export const workspaceProfileCatalog = profileCatalog;

export const e2eWorkspaceBoundary = (
  profileId: WorkspaceProfileId,
): WorkspaceBoundary => {
  const profile = profileCatalog[profileId];
  return {
    environment: { headRevision: "rev_0185" },
    session: { active: true, displayName: "Ari Stone" },
    profile: { id: profileId, ...profile },
    device: { active: false, label: "No active Device" },
    grantsReady: false,
    epochCurrent: true,
    rotationRequired: false,
    crypto: { available: false, problemCode: "crypto_provider_unavailable" },
  };
};

export const fetchWorkspaceBoundary = async (
  profileId: WorkspaceProfileId,
): Promise<WorkspaceBoundary> => {
  const response = await fetch(
    `/api/workspace/boundary?profile=${encodeURIComponent(profileId)}`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error("workspace boundary request failed");
  return response.json() as Promise<WorkspaceBoundary>;
};

export const resolveWebOrigin = (): string =>
  process.env.NEXT_PUBLIC_WEB_ORIGIN ??
  process.env.WEB_ORIGIN ??
  "http://localhost:3000";

export const resolveApiOrigin = (): string | undefined =>
  process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN ??
  process.env.DOTRELAY_API_ORIGIN ??
  process.env.SERVER_PROFILE_ORIGIN;

export const resolveOAuthCallbackUrl = (): string =>
  `${resolveWebOrigin()}/workspace`;
