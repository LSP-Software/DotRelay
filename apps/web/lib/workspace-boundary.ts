export type WorkspaceProfileId = "hosted" | "self-hosted";
export type MembershipRole = "OWNER" | "ADMIN" | "MEMBER";
export type ResourceLifecycle = "ACTIVE" | "ARCHIVED";

export type WorkspaceTeam = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly role: MembershipRole;
}>;

export type WorkspaceEnvironmentSummary = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly lifecycle: ResourceLifecycle;
  readonly currentHeadId: string | null;
}>;

export type WorkspaceProject = Readonly<{
  readonly id: string;
  readonly teamId: string;
  readonly githubRepositoryId: string;
  readonly lifecycle: ResourceLifecycle;
  readonly environments: readonly WorkspaceEnvironmentSummary[];
  readonly repository?: Readonly<{
    readonly owner: string;
    readonly name: string;
  }>;
}>;

export type WorkspaceCatalog = Readonly<{
  readonly teams: readonly WorkspaceTeam[];
  readonly projects: readonly WorkspaceProject[];
}>;

export type WorkspaceBoundary = Readonly<{
  readonly source: "fixture" | "live";
  readonly connection: "online" | "offline";
  readonly catalog: WorkspaceCatalog;
  readonly environment: Readonly<{
    readonly headRevision: string;
    readonly id?: string;
    readonly label?: string;
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
  readonly signingTrustKeys?: readonly string[];
  readonly epochGrant?: string;
  readonly peerDevices?: readonly Readonly<{
    readonly id: string;
    readonly encryptionPublicKey: string;
    readonly signingPublicKey: string;
    readonly hasEpochGrant: boolean;
  }>[];
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

const fixtureTeams: readonly WorkspaceTeam[] = [
  {
    id: "00000000-0000-4000-8000-000000000011",
    name: "LSP Software",
    role: "OWNER",
  },
  {
    id: "00000000-0000-4000-8000-000000000012",
    name: "Acme Labs",
    role: "MEMBER",
  },
];

const fixtureProjects: readonly WorkspaceProject[] = [
  {
    id: "00000000-0000-4000-8000-000000000021",
    teamId: "00000000-0000-4000-8000-000000000011",
    githubRepositoryId: "884193201",
    lifecycle: "ACTIVE",
    repository: { owner: "LSP-Software", name: "DotRelay" },
    environments: [
      {
        id: "00000000-0000-4000-8000-000000000031",
        label: "production",
        lifecycle: "ACTIVE",
        currentHeadId: "rev_0184",
      },
      {
        id: "00000000-0000-4000-8000-000000000032",
        label: "staging",
        lifecycle: "ACTIVE",
        currentHeadId: "rev_0102",
      },
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000022",
    teamId: "00000000-0000-4000-8000-000000000012",
    githubRepositoryId: "102938475",
    lifecycle: "ACTIVE",
    repository: { owner: "acme", name: "widget" },
    environments: [
      {
        id: "00000000-0000-4000-8000-000000000033",
        label: "default",
        lifecycle: "ACTIVE",
        currentHeadId: null,
      },
    ],
  },
];

export const workspaceProfileCatalog = profileCatalog;

export const projectDisplayName = (project: WorkspaceProject): string =>
  project.repository
    ? `${project.repository.owner} / ${project.repository.name}`
    : `Repository ${project.githubRepositoryId}`;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asLifecycle = (value: unknown): ResourceLifecycle =>
  value === "ARCHIVED" || value === "archived" ? "ARCHIVED" : "ACTIVE";

const asRole = (value: unknown): MembershipRole =>
  value === "ADMIN" || value === "MEMBER" ? value : "OWNER";

const parseRepository = (
  value: unknown,
): WorkspaceProject["repository"] | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const repository = value as Record<string, unknown>;
  const owner = asString(repository.owner);
  const name = asString(repository.name);
  if (!owner || !name) return undefined;
  return { owner, name };
};

export type EnrolledDeviceRow = Readonly<{
  readonly id: string;
  readonly current: boolean;
  readonly hasEpochGrant: boolean;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const parsePeerDevices = (
  value: unknown,
): NonNullable<WorkspaceBoundary["peerDevices"]> => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = asString(entry.id);
    const encryptionPublicKey = asString(entry.encryptionPublicKey);
    if (!id || !encryptionPublicKey) return [];
    return [
      {
        id,
        encryptionPublicKey,
        signingPublicKey: asString(entry.signingPublicKey) ?? "",
        hasEpochGrant: entry.hasEpochGrant === true,
      },
    ];
  });
};

export const enrolledDeviceRows = (
  boundary: Pick<WorkspaceBoundary, "device" | "peerDevices" | "grantsReady">,
  options: Readonly<{ readonly thisBrowserEnrolled: boolean }>,
): readonly EnrolledDeviceRow[] => {
  const rows: EnrolledDeviceRow[] = [];
  const seen = new Set<string>();
  if (boundary.device.id) {
    seen.add(boundary.device.id);
    rows.push({
      id: boundary.device.id,
      current: options.thisBrowserEnrolled,
      hasEpochGrant: boundary.grantsReady,
    });
  }
  for (const peer of boundary.peerDevices ?? []) {
    if (seen.has(peer.id)) continue;
    seen.add(peer.id);
    rows.push({
      id: peer.id,
      current: false,
      hasEpochGrant: peer.hasEpochGrant,
    });
  }
  return rows;
};

export const parseWorkspaceCatalog = (value: unknown): WorkspaceCatalog => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { teams: [], projects: [] };
  const catalog = value as {
    readonly teams?: unknown;
    readonly projects?: unknown;
  };
  const teams = Array.isArray(catalog.teams)
    ? catalog.teams.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const team = entry as Record<string, unknown>;
        const id = asString(team.id);
        const name = asString(team.name);
        if (!id || !name) return [];
        return [{ id, name, role: asRole(team.role) }];
      })
    : [];
  const projects = Array.isArray(catalog.projects)
    ? catalog.projects.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const project = entry as Record<string, unknown>;
        const id = asString(project.id);
        const teamId = asString(project.teamId);
        const githubRepositoryId = asString(project.githubRepositoryId);
        if (!id || !teamId || !githubRepositoryId) return [];
        const environments = Array.isArray(project.environments)
          ? project.environments.flatMap((environmentEntry) => {
              if (
                environmentEntry === null ||
                typeof environmentEntry !== "object"
              )
                return [];
              const environment = environmentEntry as Record<string, unknown>;
              const environmentId = asString(environment.id);
              const label = asString(environment.label);
              if (!environmentId || !label) return [];
              return [
                {
                  id: environmentId,
                  label,
                  lifecycle: asLifecycle(environment.lifecycle),
                  currentHeadId:
                    typeof environment.currentHeadId === "string"
                      ? environment.currentHeadId
                      : null,
                },
              ];
            })
          : [];
        const repository = parseRepository(project.repository);
        return [
          {
            id,
            teamId,
            githubRepositoryId,
            lifecycle: asLifecycle(project.lifecycle),
            environments,
            ...(repository ? { repository } : {}),
          },
        ];
      })
    : [];
  return { teams, projects };
};

export const emptyWorkspaceBoundary = (
  profileId: WorkspaceProfileId,
  options?: Readonly<{
    readonly origin?: string;
    readonly session?: WorkspaceBoundary["session"];
    readonly connection?: "online" | "offline";
  }>,
): WorkspaceBoundary => {
  const profile = profileCatalog[profileId];
  return {
    source: "live",
    connection: options?.connection ?? "offline",
    catalog: { teams: [], projects: [] },
    environment: { headRevision: "empty-environment" },
    session: options?.session ?? { active: false },
    profile: {
      id: profileId,
      ...profile,
      ...(options?.origin ? { origin: options.origin } : {}),
    },
    device: { active: false, label: "No active Device" },
    grantsReady: false,
    epochCurrent: false,
    rotationRequired: false,
    crypto: { available: true },
  };
};

export const e2eWorkspaceBoundary = (
  profileId: WorkspaceProfileId,
  options?: Readonly<{ readonly environmentId?: string }>,
): WorkspaceBoundary => {
  const profile = profileCatalog[profileId];
  const requestedEnvironment = fixtureProjects
    .flatMap((project) => project.environments)
    .find((environment) => environment.id === options?.environmentId);
  const environmentProject = requestedEnvironment
    ? fixtureProjects.find((project) =>
        project.environments.some(
          (candidate) => candidate.id === requestedEnvironment.id,
        ),
      )
    : fixtureProjects[0];
  const environment =
    requestedEnvironment ?? environmentProject?.environments[0];
  return {
    source: "fixture",
    connection: "online",
    catalog: {
      teams: fixtureTeams,
      projects: fixtureProjects,
    },
    environment: {
      headRevision: environment?.currentHeadId ?? "rev_0185",
      ...(environment ? { id: environment.id } : {}),
      ...(environment ? { label: environment.label } : {}),
      ...(environmentProject ? { projectId: environmentProject.id } : {}),
      ...(environmentProject ? { teamId: environmentProject.teamId } : {}),
    },
    session: { active: true, displayName: "Ari Stone" },
    profile: { id: profileId, ...profile },
    device: { active: false, label: "No active Device" },
    peerDevices: [
      {
        id: "00000000-0000-4000-8000-000000000041",
        encryptionPublicKey: "11".repeat(32),
        signingPublicKey: "22".repeat(32),
        hasEpochGrant: true,
      },
      {
        id: "00000000-0000-4000-8000-000000000042",
        encryptionPublicKey: "33".repeat(32),
        signingPublicKey: "44".repeat(32),
        hasEpochGrant: false,
      },
    ],
    grantsReady: false,
    epochCurrent: true,
    rotationRequired: false,
    crypto: { available: true },
  };
};

export const BROWSER_DEVICE_ID_HEADER = "X-DotRelay-Device-Id";

const isWorkspaceBoundary = (value: unknown): value is WorkspaceBoundary => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  const catalog = candidate.catalog;
  const environment = candidate.environment;
  const session = candidate.session;
  const profile = candidate.profile;
  const device = candidate.device;
  const crypto = candidate.crypto;
  return (
    (candidate.source === "live" || candidate.source === "fixture") &&
    (candidate.connection === "online" || candidate.connection === "offline") &&
    typeof candidate.grantsReady === "boolean" &&
    typeof candidate.epochCurrent === "boolean" &&
    typeof candidate.rotationRequired === "boolean" &&
    catalog !== null &&
    typeof catalog === "object" &&
    !Array.isArray(catalog) &&
    Array.isArray((catalog as { readonly teams?: unknown }).teams) &&
    Array.isArray((catalog as { readonly projects?: unknown }).projects) &&
    environment !== null &&
    typeof environment === "object" &&
    !Array.isArray(environment) &&
    typeof (environment as { readonly headRevision?: unknown }).headRevision ===
      "string" &&
    session !== null &&
    typeof session === "object" &&
    !Array.isArray(session) &&
    typeof (session as { readonly active?: unknown }).active === "boolean" &&
    profile !== null &&
    typeof profile === "object" &&
    !Array.isArray(profile) &&
    typeof (profile as { readonly origin?: unknown }).origin === "string" &&
    device !== null &&
    typeof device === "object" &&
    !Array.isArray(device) &&
    typeof (device as { readonly active?: unknown }).active === "boolean" &&
    crypto !== null &&
    typeof crypto === "object" &&
    !Array.isArray(crypto) &&
    typeof (crypto as { readonly available?: unknown }).available === "boolean"
  );
};

export const fetchWorkspaceBoundary = async (
  profileId: WorkspaceProfileId,
  options?: Readonly<{
    readonly deviceId?: string;
    readonly environmentId?: string;
  }>,
): Promise<WorkspaceBoundary> => {
  const params = new URLSearchParams({ profile: profileId });
  if (options?.environmentId) params.set("environment", options.environmentId);
  const response = await fetch(`/api/workspace/boundary?${params}`, {
    cache: "no-store",
    ...(options?.deviceId
      ? { headers: { [BROWSER_DEVICE_ID_HEADER]: options.deviceId } }
      : {}),
  });
  if (!response.ok) throw new Error("workspace boundary request failed");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("workspace boundary response is malformed");
  }
  if (!isWorkspaceBoundary(body))
    throw new Error("workspace boundary response is malformed");
  return body;
};

export const resolveWebOrigin = (): string =>
  process.env.NEXT_PUBLIC_WEB_ORIGIN ??
  process.env.WEB_ORIGIN ??
  "http://localhost:3000";

export const resolveApiOrigin = (): string | undefined =>
  process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN ??
  process.env.DOTRELAY_API_ORIGIN ??
  process.env.SERVER_PROFILE_ORIGIN;

export const resolveLiveApiOrigin = (): string | undefined => {
  if (process.env.DOTRELAY_WORKSPACE_FIXTURE === "1") return resolveApiOrigin();
  return resolveApiOrigin() ?? "http://localhost:3001";
};

export const resolveOAuthCallbackUrl = (): string =>
  `${resolveWebOrigin()}/workspace`;
