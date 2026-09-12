import { expect, test } from "bun:test";
import {
  type EnvironmentContextIdentity,
  environmentContextIdentity,
  environmentContextKey,
  planContextSwitch,
  sameEnvironmentContext,
  sessionMatchesContext,
} from "./environment-context";

const identity = (
  overrides: Partial<EnvironmentContextIdentity> = {},
): EnvironmentContextIdentity => ({
  profileId: "hosted",
  serverProfileId: "sp_01",
  teamId: "team_1",
  projectId: "project_1",
  environmentId: "env_1",
  ...overrides,
});

test("context keys scope drafts to Server Profile, Team, Project, and Environment", () => {
  expect(environmentContextKey(identity())).not.toEqual(
    environmentContextKey(identity({ environmentId: "env_2" })),
  );
  expect(environmentContextKey(identity())).not.toEqual(
    environmentContextKey(identity({ projectId: "project_2" })),
  );
  expect(environmentContextKey(identity())).not.toEqual(
    environmentContextKey(identity({ teamId: "team_2" })),
  );
  expect(environmentContextKey(identity())).not.toEqual(
    environmentContextKey(identity({ profileId: "self-hosted" })),
  );
  expect(
    environmentContextKey(
      identity({ profileId: "self-hosted", serverProfileId: "sp_02" }),
    ),
  ).not.toEqual(environmentContextKey(identity()));
});

test("context keys stay distinct when optional scopes are absent", () => {
  const bare = identity({
    serverProfileId: null,
    teamId: null,
    projectId: null,
    environmentId: null,
  });
  expect(environmentContextKey(bare)).not.toEqual(
    environmentContextKey(
      identity({ teamId: null, projectId: null, environmentId: null }),
    ),
  );
  expect(
    environmentContextKey(identity({ projectId: null, environmentId: null })),
  ).not.toEqual(
    environmentContextKey(
      identity({ projectId: "project_1", environmentId: null }),
    ),
  );
  expect(environmentContextKey(identity({ environmentId: null }))).not.toEqual(
    environmentContextKey(identity()),
  );
});

test("same-context comparison covers every scope", () => {
  expect(sameEnvironmentContext(identity(), identity())).toBe(true);
  expect(
    sameEnvironmentContext(identity(), identity({ environmentId: "env_2" })),
  ).toBe(false);
  expect(
    sameEnvironmentContext(identity(), identity({ serverProfileId: "sp_02" })),
  ).toBe(false);
});

const contextOf = (
  overrides: Partial<{
    serverProfileId: string;
    teamId: string;
    projectId: string;
    environmentId: string;
  }> = {},
) => ({
  serverProfileId: "sp_01",
  teamId: "team_1",
  projectId: "project_1",
  environmentId: "env_1",
  ...overrides,
});

test("a session only matches the context it was created for", () => {
  expect(sessionMatchesContext(contextOf(), identity())).toBe(true);
  expect(
    sessionMatchesContext(contextOf({ environmentId: "env_2" }), identity()),
  ).toBe(false);
  expect(
    sessionMatchesContext(contextOf({ projectId: "project_2" }), identity()),
  ).toBe(false);
  expect(
    sessionMatchesContext(contextOf({ teamId: "team_2" }), identity()),
  ).toBe(false);
  expect(
    sessionMatchesContext(contextOf({ serverProfileId: "sp_02" }), identity()),
  ).toBe(false);
});

test("known identity fields reject a mismatched session even when others are unknown", () => {
  const partial = identity({
    serverProfileId: null,
    teamId: null,
    projectId: null,
  });
  expect(sessionMatchesContext(contextOf(), partial)).toBe(true);
  expect(
    sessionMatchesContext(contextOf({ environmentId: "env_2" }), partial),
  ).toBe(false);
  expect(sessionMatchesContext(contextOf({ teamId: "team_2" }), partial)).toBe(
    true,
  );
});

test("switching within the same context is a no-op", () => {
  expect(
    planContextSwitch({
      current: identity(),
      next: identity(),
      dirtyDraft: true,
    }),
  ).toEqual({ type: "noop" });
});

test("crossing Server Profiles rebinds the workspace even with a dirty draft", () => {
  expect(
    planContextSwitch({
      current: identity(),
      next: identity({
        profileId: "self-hosted",
        serverProfileId: "sp_02",
      }),
      dirtyDraft: true,
    }),
  ).toEqual({ type: "rebind" });
});

test("context identity normalizes absent scopes to null", () => {
  expect(
    environmentContextIdentity({
      profileId: "hosted",
      teamId: "team_1",
    }),
  ).toEqual({
    profileId: "hosted",
    serverProfileId: null,
    teamId: "team_1",
    projectId: null,
    environmentId: null,
  });
  expect(
    environmentContextIdentity({
      profileId: "hosted",
      serverProfileId: "sp_01",
      teamId: "team_1",
      projectId: "project_1",
      environmentId: "env_1",
    }),
  ).toEqual(identity());
});

test("a dirty draft asks whether to keep or discard it", () => {
  expect(
    planContextSwitch({
      current: identity(),
      next: identity({ environmentId: "env_2" }),
      dirtyDraft: true,
    }),
  ).toEqual({ type: "prompt" });
  expect(
    planContextSwitch({
      current: identity(),
      next: identity({
        teamId: "team_2",
        projectId: null,
        environmentId: null,
      }),
      dirtyDraft: true,
    }),
  ).toEqual({ type: "prompt" });
});

test("a clean context switches without prompting", () => {
  expect(
    planContextSwitch({
      current: identity(),
      next: identity({ environmentId: "env_2" }),
      dirtyDraft: false,
    }),
  ).toEqual({ type: "switch" });
});
