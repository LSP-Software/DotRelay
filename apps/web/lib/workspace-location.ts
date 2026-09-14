import {
  type WorkspaceCatalog,
  type WorkspaceProfileId,
  workspaceProfileCatalog,
} from "./workspace-boundary";

export const WORKSPACE_VIEWS = [
  "projects",
  "environment",
  "team",
  "devices",
  "recovery",
] as const;

export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];

export const WORKSPACE_DEFAULT_PROFILE_ID: WorkspaceProfileId = "hosted";

export const WORKSPACE_PROFILE_IDS: readonly string[] = Object.keys(
  workspaceProfileCatalog,
);

/**
 * Raw location parsed from the page URL. Profile and view are validated
 * immediately; team, project, and environment ids are validated later, once
 * the workspace catalog is known.
 */
export type ParsedWorkspaceLocation = Readonly<{
  readonly profileId: WorkspaceProfileId;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  readonly view: WorkspaceView | null;
}>;

export type WorkspaceMissingResource =
  | Readonly<{ readonly kind: "team" }>
  | Readonly<{ readonly kind: "project" }>
  | Readonly<{ readonly kind: "environment" }>;

/**
 * A location whose ids are validated against the workspace catalog and whose
 * view is resolved, suitable for driving both app state and the page URL.
 */
export type ResolvedWorkspaceLocation = Readonly<{
  readonly profileId: WorkspaceProfileId;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  readonly view: WorkspaceView;
  readonly missing: WorkspaceMissingResource | null;
}>;

export type WorkspaceLocation = Readonly<{
  readonly profileId: WorkspaceProfileId;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  readonly view: WorkspaceView;
}>;

export const parseWorkspaceLocation = (
  search: URLSearchParams,
  knownProfiles: readonly string[] = WORKSPACE_PROFILE_IDS,
): ParsedWorkspaceLocation => {
  const profileId = search.get("profile");
  const view = search.get("view");
  return {
    profileId:
      profileId && knownProfiles.includes(profileId)
        ? (profileId as WorkspaceProfileId)
        : WORKSPACE_DEFAULT_PROFILE_ID,
    teamId: search.get("team"),
    projectId: search.get("project"),
    environmentId: search.get("environment"),
    view:
      view && (WORKSPACE_VIEWS as readonly string[]).includes(view)
        ? (view as WorkspaceView)
        : null,
  };
};

export const serializeWorkspaceLocation = (
  location: Readonly<{
    readonly profileId: WorkspaceProfileId;
    readonly teamId: string | null;
    readonly projectId: string | null;
    readonly environmentId: string | null;
    readonly view: WorkspaceView;
  }>,
  baseSearch: URLSearchParams,
): string => {
  const params = new URLSearchParams(baseSearch);
  params.set("profile", location.profileId);
  params.set("view", location.view);
  const assign = (key: string, value: string | null) => {
    if (value) params.set(key, value);
    else params.delete(key);
  };
  assign("team", location.teamId);
  assign("project", location.projectId);
  assign("environment", location.environmentId);
  return params.toString();
};

export const sameWorkspaceLocation = (
  a: WorkspaceLocation,
  b: WorkspaceLocation,
): boolean =>
  a.profileId === b.profileId &&
  a.teamId === b.teamId &&
  a.projectId === b.projectId &&
  a.environmentId === b.environmentId &&
  a.view === b.view;

export const readHistorySeq = (state: unknown): number => {
  if (state === null || typeof state !== "object") return 0;
  const seq = (state as { readonly seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : 0;
};

/**
 * Validate a parsed location against the workspace catalog. A missing Team
 * falls back to the first Team, a missing Project drops the Project and
 * Environment, and a missing Environment falls back to the Project's first
 * Environment. `missing` names the first resource, from the top down, that
 * the caller asked for and the catalog could not provide, so the shell can
 * offer a recovery path instead of a blank page.
 */
export const resolveWorkspaceLocation = (
  parsed: ParsedWorkspaceLocation,
  catalog: WorkspaceCatalog,
  viewFallback: (hasProject: boolean) => WorkspaceView,
): ResolvedWorkspaceLocation => {
  const teams = catalog.teams;
  const projects = catalog.projects;
  let missing: WorkspaceMissingResource | null = null;
  const teamKnown =
    parsed.teamId !== null && teams.some((team) => team.id === parsed.teamId);
  const teamId = teamKnown ? parsed.teamId : (teams[0]?.id ?? null);
  if (parsed.teamId !== null && !teamKnown) missing = { kind: "team" };
  let projectId: string | null = null;
  if (parsed.projectId !== null && missing === null) {
    const team = teams.find((candidate) => candidate.id === teamId) ?? null;
    const project = team
      ? projects.find(
          (candidate) =>
            candidate.id === parsed.projectId && candidate.teamId === team.id,
        )
      : null;
    if (project) projectId = project.id;
    else missing = { kind: "project" };
  }
  let environmentId: string | null = null;
  if (projectId !== null) {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (parsed.environmentId !== null) {
      const environment = project?.environments.find(
        (candidate) => candidate.id === parsed.environmentId,
      );
      if (environment) {
        environmentId = environment.id;
      } else {
        environmentId = project?.environments[0]?.id ?? null;
        if (missing === null) missing = { kind: "environment" };
      }
    } else {
      environmentId = project?.environments[0]?.id ?? null;
    }
  }
  let view = parsed.view ?? viewFallback(projectId !== null);
  if (view === "environment" && (projectId === null || environmentId === null))
    view = "projects";
  return {
    profileId: parsed.profileId,
    teamId,
    projectId,
    environmentId,
    view,
    missing,
  };
};
