import { expect, test } from "bun:test";
import {
  createTeamInvitation,
  fetchMyInvitations,
  fetchTeamMemberships,
  parseMyInvitations,
  parseTeamMembershipState,
  resolveGitHubLogin,
} from "./team-administration";

const privilegedBody = {
  memberships: [
    {
      membershipId: "m1",
      userId: "u1",
      name: "Ari Stone",
      image: null,
      githubSubject: "1001",
      role: "OWNER",
      lifecycle: "ACTIVE",
      createdAt: "2026-01-01T00:00:00.000Z",
      activatedAt: "2026-01-01T00:00:00.000Z",
      removedAt: null,
    },
    {
      membershipId: "m2",
      userId: "u2",
      name: null,
      image: null,
      githubSubject: "2002",
      role: "MEMBER",
      lifecycle: "PENDING_KEY_GRANT",
      createdAt: "2026-01-02T00:00:00.000Z",
      activatedAt: null,
      removedAt: null,
    },
  ],
  invitations: [
    {
      invitationId: "i1",
      providerSubject: "583231",
      createdAt: "2026-01-03T00:00:00.000Z",
      expiresAt: "2026-01-10T00:00:00.000Z",
    },
  ],
};

test("parseTeamMembershipState keeps roles for privileged callers", () => {
  const state = parseTeamMembershipState(privilegedBody);
  expect(state?.memberships).toHaveLength(2);
  expect(state?.memberships[0]?.role).toBe("OWNER");
  expect(state?.memberships[0]?.name).toBe("Ari Stone");
  expect(state?.memberships[1]?.lifecycle).toBe("PENDING_KEY_GRANT");
  expect(state?.invitations).toHaveLength(1);
  expect(state?.invitations[0]?.providerSubject).toBe("583231");
});

test("parseTeamMembershipState omits role for non-privileged payloads", () => {
  const state = parseTeamMembershipState({
    memberships: [
      {
        membershipId: "m1",
        userId: "u1",
        name: "Ari",
        image: null,
        githubSubject: "1001",
        lifecycle: "ACTIVE",
      },
    ],
    invitations: [],
  });
  expect(state?.memberships).toHaveLength(1);
  expect(state?.memberships[0]?.role).toBeUndefined();
  expect(state?.invitations).toEqual([]);
});

test("parseTeamMembershipState rejects non-object bodies and drops invalid rows", () => {
  expect(parseTeamMembershipState(null)).toBeNull();
  expect(parseTeamMembershipState("nope")).toBeNull();
  const partial = parseTeamMembershipState({
    memberships: [{ membershipId: "m1" }],
    invitations: [],
  });
  expect(partial).not.toBeNull();
  expect(partial?.memberships).toEqual([]);
});

test("parseMyInvitations keeps addressed invitations and pending teams", () => {
  const parsed = parseMyInvitations({
    invitations: [
      {
        invitationId: "i1",
        teamId: "t1",
        teamName: "Alpha",
        providerSubject: "583231",
        createdAt: "2026-01-03T00:00:00.000Z",
        expiresAt: "2026-01-10T00:00:00.000Z",
      },
    ],
    pendingMemberships: [{ teamId: "t2", teamName: "Beta" }],
  });
  expect(parsed?.invitations).toHaveLength(1);
  expect(parsed?.invitations[0]?.teamName).toBe("Alpha");
  expect(parsed?.pendingMemberships).toEqual([
    { teamId: "t2", teamName: "Beta" },
  ]);
});

const stubFetch = (
  handler: (url: string, init?: RequestInit) => Response,
): (() => void) => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => handler(String(input), init)) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
};

test("fetchTeamMemberships reads the persisted Team record", async () => {
  const restore = stubFetch(() => Response.json(privilegedBody));
  try {
    const result = await fetchTeamMemberships("http://api.test", "team-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.memberships).toHaveLength(2);
    expect(result.data.invitations).toHaveLength(1);
  } finally {
    restore();
  }
});

test("fetchTeamMemberships turns a problem code into an actionable message", async () => {
  const restore = stubFetch(() =>
    Response.json(
      { code: "resource_not_found", title: "Not found" },
      { status: 404 },
    ),
  );
  try {
    const result = await fetchTeamMemberships("http://api.test", "team-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("We couldn't find that on this server.");
  } finally {
    restore();
  }
});

test("resolveGitHubLogin reports an unknown login actionably", async () => {
  const restore = stubFetch(() =>
    Response.json(
      { code: "github_identity_not_found", title: "Not found" },
      { status: 404 },
    ),
  );
  try {
    const result = await resolveGitHubLogin("http://api.test", "nobody");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("GitHub login");
  } finally {
    restore();
  }
});

test("createTeamInvitation sends an idempotency key and the device id", async () => {
  const captured = { url: "", headers: new Headers() };
  const restore = stubFetch((url, init) => {
    captured.url = url;
    captured.headers = new Headers(init?.headers);
    return Response.json(
      {
        invitationId: "i9",
        teamId: "team-1",
        providerSubject: "583231",
        createdAt: "2026-01-03T00:00:00.000Z",
        expiresAt: "2026-01-10T00:00:00.000Z",
      },
      { status: 201 },
    );
  });
  try {
    const result = await createTeamInvitation(
      "http://api.test",
      "team-1",
      "583231",
      "device-1",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.invitationId).toBe("i9");
    expect(captured.url).toBe(
      "http://api.test/api/v1/teams/team-1/invitations",
    );
    expect(captured.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured.headers.get("X-DotRelay-Device-Id")).toBe("device-1");
  } finally {
    restore();
  }
});

test("fetchMyInvitations reports a network failure actionably", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  try {
    const result = await fetchMyInvitations("http://api.test");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("reach the server");
  } finally {
    globalThis.fetch = previous;
  }
});
