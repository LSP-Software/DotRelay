import { expect, test } from "bun:test";
import type { WorkspaceCatalog } from "./workspace-boundary";
import {
  parseWorkspaceLocation,
  readHistorySeq,
  resolveWorkspaceLocation,
  sameWorkspaceLocation,
  serializeWorkspaceLocation,
  type WorkspaceView,
} from "./workspace-location";

const viewFallback = (hasProject: boolean): WorkspaceView =>
  hasProject ? "environment" : "projects";

const catalogFixture = (): WorkspaceCatalog => ({
  teams: [
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
  ],
  projects: [
    {
      id: "00000000-0000-4000-8000-000000000021",
      teamId: "00000000-0000-4000-8000-000000000011",
      githubRepositoryId: "884193201",
      lifecycle: "ACTIVE",
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
      environments: [
        {
          id: "00000000-0000-4000-8000-000000000033",
          label: "default",
          lifecycle: "ACTIVE",
          currentHeadId: null,
        },
      ],
    },
  ],
});

test("parse keeps valid profile and view and defaults invalid ones", () => {
  const parsed = parseWorkspaceLocation(
    new URLSearchParams(
      "profile=self-hosted&team=t1&project=p1&environment=e1&view=team&preview=protected",
    ),
  );
  expect(parsed.profileId).toBe("self-hosted");
  expect(parsed.teamId).toBe("t1");
  expect(parsed.projectId).toBe("p1");
  expect(parsed.environmentId).toBe("e1");
  expect(parsed.view).toBe("team");

  const invalid = parseWorkspaceLocation(
    new URLSearchParams("profile=rogue&view=nowhere&team=t1"),
  );
  expect(invalid.profileId).toBe("hosted");
  expect(invalid.view).toBe(null);
  expect(invalid.teamId).toBe("t1");
});

test("parse defaults to the hosted profile and omits ids", () => {
  const parsed = parseWorkspaceLocation(new URLSearchParams(""));
  expect(parsed).toEqual({
    profileId: "hosted",
    teamId: null,
    projectId: null,
    environmentId: null,
    view: null,
  });
});

test("serialize writes profile and view and drops null ids", () => {
  const search = serializeWorkspaceLocation(
    {
      profileId: "self-hosted",
      teamId: "t1",
      projectId: null,
      environmentId: null,
      view: "team",
    },
    new URLSearchParams("preview=protected"),
  );
  const params = new URLSearchParams(search);
  expect(params.get("profile")).toBe("self-hosted");
  expect(params.get("team")).toBe("t1");
  expect(params.get("view")).toBe("team");
  expect(params.get("project")).toBe(null);
  expect(params.get("environment")).toBe(null);
  expect(params.get("preview")).toBe("protected");
});

test("serialize removes ids no longer selected", () => {
  const base = new URLSearchParams(
    "profile=hosted&team=t1&project=p1&environment=e1&view=environment",
  );
  const search = serializeWorkspaceLocation(
    {
      profileId: "hosted",
      teamId: "t1",
      projectId: null,
      environmentId: null,
      view: "projects",
    },
    base,
  );
  const params = new URLSearchParams(search);
  expect(params.get("team")).toBe("t1");
  expect(params.get("project")).toBe(null);
  expect(params.get("environment")).toBe(null);
  expect(params.get("view")).toBe("projects");
});

test("sameWorkspaceLocation compares all five fields", () => {
  const a = {
    profileId: "hosted" as const,
    teamId: "t1",
    projectId: "p1",
    environmentId: "e1",
    view: "environment" as const,
  };
  expect(sameWorkspaceLocation(a, { ...a })).toBe(true);
  expect(sameWorkspaceLocation(a, { ...a, view: "team" as const })).toBe(false);
  expect(sameWorkspaceLocation(a, { ...a, teamId: null })).toBe(false);
});

test("readHistorySeq reads a finite number and defaults to zero", () => {
  expect(readHistorySeq({ seq: 3 })).toBe(3);
  expect(readHistorySeq({ seq: "no" })).toBe(0);
  expect(readHistorySeq(null)).toBe(0);
  expect(readHistorySeq(undefined)).toBe(0);
  expect(readHistorySeq({})).toBe(0);
});

test("resolve validates a full chain against the catalog", () => {
  const resolved = resolveWorkspaceLocation(
    parseWorkspaceLocation(
      new URLSearchParams(
        "profile=hosted&team=00000000-0000-4000-8000-000000000011&project=00000000-0000-4000-8000-000000000021&environment=00000000-0000-4000-8000-000000000032&view=environment",
      ),
    ),
    catalogFixture(),
    viewFallback,
  );
  expect(resolved.teamId).toBe("00000000-0000-4000-8000-000000000011");
  expect(resolved.projectId).toBe("00000000-0000-4000-8000-000000000021");
  expect(resolved.environmentId).toBe("00000000-0000-4000-8000-000000000032");
  expect(resolved.view).toBe("environment");
  expect(resolved.missing).toBe(null);
});

test("resolve picks the first environment for a project deep link", () => {
  const resolved = resolveWorkspaceLocation(
    parseWorkspaceLocation(
      new URLSearchParams(
        "profile=hosted&project=00000000-0000-4000-8000-000000000021",
      ),
    ),
    catalogFixture(),
    viewFallback,
  );
  expect(resolved.teamId).toBe("00000000-0000-4000-8000-000000000011");
  expect(resolved.projectId).toBe("00000000-0000-4000-8000-000000000021");
  expect(resolved.environmentId).toBe("00000000-0000-4000-8000-000000000031");
  expect(resolved.view).toBe("environment");
  expect(resolved.missing).toBe(null);
});

test("resolve falls back to the first team for a deleted team", () => {
  const resolved = resolveWorkspaceLocation(
    parseWorkspaceLocation(
      new URLSearchParams("profile=hosted&team=deleted-team"),
    ),
    catalogFixture(),
    viewFallback,
  );
  expect(resolved.teamId).toBe("00000000-0000-4000-8000-000000000011");
  expect(resolved.missing).toEqual({ kind: "team" });
});

test("resolve drops a deleted project and returns to the projects view", () => {
  const resolved = resolveWorkspaceLocation(
    parseWorkspaceLocation(
      new URLSearchParams(
        "profile=hosted&team=00000000-0000-4000-8000-000000000011&project=deleted-project&view=environment",
      ),
    ),
    catalogFixture(),
    viewFallback,
  );
  expect(resolved.projectId).toBe(null);
  expect(resolved.environmentId).toBe(null);
  expect(resolved.view).toBe("projects");
  expect(resolved.missing).toEqual({ kind: "project" });
});

test("resolve rejects a project from another team", () => {
  const resolved = resolveWorkspaceLocation(
    parseWorkspaceLocation(
      new URLSearchParams(
        "profile=hosted&team=00000000-0000-4000-8000-000000000011&project=00000000-0000-4000-8000-000000000022",
      ),
    ),
    catalogFixture(),
    viewFallback,
  );
  expect(resolved.projectId).toBe(null);
  expect(resolved.view).toBe("projects");
  expect(resolved.missing).toEqual({ kind: "project" });
});

test("resolve falls back to the first environment for a deleted environment", () => {
  const resolved = resolveWorkspaceLocation(
    parseWorkspaceLocation(
      new URLSearchParams(
        "profile=hosted&team=00000000-0000-4000-8000-000000000011&project=00000000-0000-4000-8000-000000000021&environment=deleted-environment&view=environment",
      ),
    ),
    catalogFixture(),
    viewFallback,
  );
  expect(resolved.projectId).toBe("00000000-0000-4000-8000-000000000021");
  expect(resolved.environmentId).toBe("00000000-0000-4000-8000-000000000031");
  expect(resolved.view).toBe("environment");
  expect(resolved.missing).toEqual({ kind: "environment" });
});

test("resolve keeps an explicit non-environment view for a valid project", () => {
  const resolved = resolveWorkspaceLocation(
    parseWorkspaceLocation(
      new URLSearchParams(
        "profile=hosted&project=00000000-0000-4000-8000-000000000021&view=recovery",
      ),
    ),
    catalogFixture(),
    viewFallback,
  );
  expect(resolved.view).toBe("recovery");
  expect(resolved.projectId).toBe("00000000-0000-4000-8000-000000000021");
});

test("resolve uses the view fallback when the URL names no view", () => {
  const resolved = resolveWorkspaceLocation(
    parseWorkspaceLocation(
      new URLSearchParams(
        "profile=hosted&team=00000000-0000-4000-8000-000000000011",
      ),
    ),
    catalogFixture(),
    (hasProject) => (hasProject ? "environment" : "devices"),
  );
  expect(resolved.view).toBe("devices");
  expect(resolved.missing).toBe(null);
});

test("resolve drops the environment view when the project has no environments", () => {
  const catalog = {
    teams: [{ id: "t1", name: "One", role: "OWNER" as const }],
    projects: [
      {
        id: "p1",
        teamId: "t1",
        githubRepositoryId: "1",
        lifecycle: "ACTIVE" as const,
        environments: [],
      },
    ],
  };
  const resolved = resolveWorkspaceLocation(
    parseWorkspaceLocation(
      new URLSearchParams(
        "profile=hosted&team=t1&project=p1&environment=e1&view=environment",
      ),
    ),
    catalog,
    viewFallback,
  );
  expect(resolved.environmentId).toBe(null);
  expect(resolved.view).toBe("projects");
  expect(resolved.missing).toEqual({ kind: "environment" });
});
