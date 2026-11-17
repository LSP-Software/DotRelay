import { expect, test } from "bun:test";
import {
  e2eWorkspaceBoundary,
  emptyWorkspaceBoundary,
  enrolledDeviceRows,
  fetchWorkspaceBoundary,
  isWorkspaceFixtureEnabled,
  parsePeerDevices,
  parseRotationOwed,
  parseWorkspaceCatalog,
  projectDisplayName,
  resolveLiveApiOrigin,
  resolveWorkspaceProfileId,
  rotationOwedCause,
} from "./workspace-boundary";

test("local workspace talks to the loopback API when no origin env is set", () => {
  const previous = {
    fixture: process.env.DOTRELAY_WORKSPACE_FIXTURE,
    nextPublic: process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN,
    api: process.env.DOTRELAY_API_ORIGIN,
    profile: process.env.SERVER_PROFILE_ORIGIN,
  };
  delete process.env.DOTRELAY_WORKSPACE_FIXTURE;
  delete process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN;
  delete process.env.DOTRELAY_API_ORIGIN;
  delete process.env.SERVER_PROFILE_ORIGIN;

  try {
    expect(resolveLiveApiOrigin()).toBe("http://localhost:3001");
  } finally {
    if (previous.fixture === undefined)
      delete process.env.DOTRELAY_WORKSPACE_FIXTURE;
    else process.env.DOTRELAY_WORKSPACE_FIXTURE = previous.fixture;
    if (previous.nextPublic === undefined)
      delete process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN;
    else process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN = previous.nextPublic;
    if (previous.api === undefined) delete process.env.DOTRELAY_API_ORIGIN;
    else process.env.DOTRELAY_API_ORIGIN = previous.api;
    if (previous.profile === undefined)
      delete process.env.SERVER_PROFILE_ORIGIN;
    else process.env.SERVER_PROFILE_ORIGIN = previous.profile;
  }
});

test("a production server without an API origin fails with a configuration error", () => {
  const keys = [
    "NODE_ENV",
    "DOTRELAY_WORKSPACE_FIXTURE",
    "NEXT_PUBLIC_DOTRELAY_API_ORIGIN",
    "DOTRELAY_API_ORIGIN",
    "SERVER_PROFILE_ORIGIN",
  ] as const;
  const env = process.env as Record<string, string | undefined>;
  const previous = keys.map((key) => [key, env[key]] as const);
  for (const key of keys) delete env[key];
  try {
    env.NODE_ENV = "production";
    expect(() => resolveLiveApiOrigin()).toThrow(
      /API origin is not configured/,
    );
    env.DOTRELAY_API_ORIGIN = "https://api.example.test";
    expect(resolveLiveApiOrigin()).toBe("https://api.example.test");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
});

test("the workspace fixture is refused in production without the e2e opt-in", () => {
  expect(isWorkspaceFixtureEnabled({})).toBe(false);
  expect(
    isWorkspaceFixtureEnabled({
      DOTRELAY_WORKSPACE_FIXTURE: "1",
      NODE_ENV: "development",
    }),
  ).toBe(true);
  expect(() =>
    isWorkspaceFixtureEnabled({
      DOTRELAY_WORKSPACE_FIXTURE: "1",
      NODE_ENV: "production",
    }),
  ).toThrow(/development-only/);
  expect(
    isWorkspaceFixtureEnabled({
      DOTRELAY_WORKSPACE_FIXTURE: "1",
      NODE_ENV: "production",
      DOTRELAY_E2E_ALLOW_PRODUCTION_FIXTURE: "1",
    }),
  ).toBe(true);
});

test("the deployment profile is declared explicitly or fails closed", () => {
  const previous = process.env.NEXT_PUBLIC_DOTRELAY_WEB_PROFILE;
  const restore = () => {
    if (previous === undefined)
      delete process.env.NEXT_PUBLIC_DOTRELAY_WEB_PROFILE;
    else process.env.NEXT_PUBLIC_DOTRELAY_WEB_PROFILE = previous;
  };
  try {
    delete process.env.NEXT_PUBLIC_DOTRELAY_WEB_PROFILE;
    expect(resolveWorkspaceProfileId()).toBe("self-hosted");

    process.env.NEXT_PUBLIC_DOTRELAY_WEB_PROFILE = "self-hosted";
    expect(resolveWorkspaceProfileId()).toBe("self-hosted");

    process.env.NEXT_PUBLIC_DOTRELAY_WEB_PROFILE = "hosted";
    expect(resolveWorkspaceProfileId()).toBe("hosted");

    process.env.NEXT_PUBLIC_DOTRELAY_WEB_PROFILE = "rogue";
    expect(resolveWorkspaceProfileId()).toBe("self-hosted");
  } finally {
    restore();
  }
});

test("catalog display uses the GitHub owner and name when present", () => {
  const catalog = parseWorkspaceCatalog({
    teams: [
      {
        id: "00000000-0000-4000-8000-000000000011",
        name: "LSP Software",
        role: "OWNER",
      },
    ],
    projects: [
      {
        id: "00000000-0000-4000-8000-000000000021",
        teamId: "00000000-0000-4000-8000-000000000011",
        githubRepositoryId: "1311418611",
        lifecycle: "ACTIVE",
        repository: { owner: "LSP-Software", name: "DotRelay" },
        environments: [
          {
            id: "00000000-0000-4000-8000-000000000031",
            label: "default",
            lifecycle: "ACTIVE",
            currentHeadId: null,
          },
        ],
      },
    ],
  });
  const project = catalog.projects[0];
  expect(project).toBeDefined();
  if (!project) throw new Error("expected a Project");
  expect(projectDisplayName(project)).toBe("LSP-Software / DotRelay");
});

test("workspace boundary keeps enrolled peer Devices", () => {
  expect(
    parsePeerDevices([
      {
        id: "00000000-0000-4000-8000-000000000041",
        encryptionPublicKey: "aa",
        signingPublicKey: "bb",
        hasEpochGrant: true,
      },
      { id: "not-a-device" },
    ]),
  ).toEqual([
    {
      id: "00000000-0000-4000-8000-000000000041",
      encryptionPublicKey: "aa",
      signingPublicKey: "bb",
      hasEpochGrant: true,
    },
  ]);
});

test("the empty boundary is a live offline state without fixture data", () => {
  const boundary = emptyWorkspaceBoundary("hosted", {
    origin: "http://localhost:3001",
    session: { active: true, displayName: "Real Person" },
    connection: "online",
  });
  expect(boundary.source).toBe("live");
  expect(boundary.connection).toBe("online");
  expect(boundary.catalog).toEqual({ teams: [], projects: [] });
  expect(boundary.session).toEqual({
    active: true,
    displayName: "Real Person",
  });
  expect(boundary.profile.origin).toBe("http://localhost:3001");
  expect(boundary.device.active).toBe(false);

  const offline = emptyWorkspaceBoundary("self-hosted");
  expect(offline.connection).toBe("offline");
  expect(offline.session).toEqual({ active: false });
  expect(offline.session.displayName).toBeUndefined();
});

test("the e2e boundary stays an explicit dev fixture", () => {
  const boundary = e2eWorkspaceBoundary("hosted");
  expect(boundary.source).toBe("fixture");
  expect(boundary.connection).toBe("online");
  expect(boundary.session).toEqual({
    active: true,
    userId: "00000000-0000-4000-8000-000000000061",
    displayName: "Ari Stone",
    image: "https://avatars.githubusercontent.com/u/000000000061",
  });
  expect(boundary.device.active).toBe(false);
  expect(boundary.grantsReady).toBe(false);

  const enrolled = e2eWorkspaceBoundary("hosted", {
    deviceId: "00000000-0000-4000-8000-000000000063",
  });
  expect(enrolled.device).toEqual({
    active: true,
    label: "This browser",
    id: "00000000-0000-4000-8000-000000000063",
    encryptionPublicKey: "55".repeat(32),
    signingPublicKey: "22".repeat(32),
  });
  expect(enrolled.grantsReady).toBe(true);
});

test("the e2e boundary describes the requested Environment", () => {
  const boundary = e2eWorkspaceBoundary("hosted", {
    environmentId: "00000000-0000-4000-8000-000000000032",
  });
  expect(boundary.environment.id).toBe("00000000-0000-4000-8000-000000000032");
  expect(boundary.environment.label).toBe("staging");
  expect(boundary.environment.headRevision).toBe("rev_0102");
  expect(boundary.environment.projectId).toBe(
    "00000000-0000-4000-8000-000000000021",
  );
  expect(boundary.environment.teamId).toBe(
    "00000000-0000-4000-8000-000000000011",
  );
  const unknown = e2eWorkspaceBoundary("hosted", {
    environmentId: "00000000-0000-4000-8000-999999999999",
  });
  expect(unknown.environment.id).toBe("00000000-0000-4000-8000-000000000031");
});

const stubBoundaryResponse = (response: Response): (() => void) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
};

test("fetchWorkspaceBoundary rejects a non-200 boundary response", async () => {
  const restore = stubBoundaryResponse(
    new Response("unavailable", { status: 503 }),
  );
  try {
    await expect(fetchWorkspaceBoundary("hosted")).rejects.toThrow(
      "workspace boundary request failed",
    );
  } finally {
    restore();
  }
});

test("fetchWorkspaceBoundary rejects a malformed boundary response", async () => {
  const restore = stubBoundaryResponse(
    new Response("not-json", {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );
  try {
    await expect(fetchWorkspaceBoundary("hosted")).rejects.toThrow(
      "workspace boundary response is malformed",
    );
  } finally {
    restore();
  }
});

test("fetchWorkspaceBoundary accepts a well-formed boundary response", async () => {
  const boundary = emptyWorkspaceBoundary("hosted", {
    origin: "http://localhost:3001",
    connection: "online",
  });
  const restore = stubBoundaryResponse(
    new Response(JSON.stringify(boundary), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );
  try {
    await expect(fetchWorkspaceBoundary("hosted")).resolves.toEqual(boundary);
  } finally {
    restore();
  }
});

test("enrolled Device rows include this browser and peer Devices", () => {
  expect(
    enrolledDeviceRows(
      {
        device: {
          active: true,
          id: "00000000-0000-4000-8000-000000000040",
          name: "Chrome on Windows",
          clientKind: "browser",
          osName: "Windows 10/11",
          clientSummary: "Chrome 140 on Windows 10/11",
        },
        grantsReady: true,
        peerDevices: [
          {
            id: "00000000-0000-4000-8000-000000000041",
            encryptionPublicKey: "aa",
            signingPublicKey: "bb",
            hasEpochGrant: false,
            name: "CatchOS Main PC",
            clientKind: "cli",
            osName: "Linux",
            clientSummary: "dotrelay-cli",
          },
        ],
      },
      { thisBrowserEnrolled: true },
    ),
  ).toEqual([
    {
      id: "00000000-0000-4000-8000-000000000040",
      current: true,
      hasEpochGrant: true,
      name: "Chrome on Windows",
      clientKind: "browser",
      osName: "Windows 10/11",
      clientSummary: "Chrome 140 on Windows 10/11",
    },
    {
      id: "00000000-0000-4000-8000-000000000041",
      current: false,
      hasEpochGrant: false,
      name: "CatchOS Main PC",
      clientKind: "cli",
      osName: "Linux",
      clientSummary: "dotrelay-cli",
    },
  ]);
});

test("a project key the account key wraps reaches every device", () => {
  const rows = enrolledDeviceRows(
    {
      device: { active: true, id: "00000000-0000-4000-8000-000000000040" },
      grantsReady: false,
      peerDevices: [
        {
          id: "00000000-0000-4000-8000-000000000041",
          encryptionPublicKey: "aa",
          signingPublicKey: "bb",
          hasEpochGrant: false,
        },
      ],
    },
    { thisBrowserEnrolled: true, keysNotPerDevice: true },
  );
  expect(rows.map((row) => row.hasEpochGrant)).toEqual([true, true]);
});

test("enrolled Device rows stay valid without display metadata", () => {
  expect(
    enrolledDeviceRows(
      {
        device: { active: true, id: "00000000-0000-4000-8000-000000000040" },
        grantsReady: false,
        peerDevices: [],
      },
      { thisBrowserEnrolled: false },
    ),
  ).toEqual([
    {
      id: "00000000-0000-4000-8000-000000000040",
      current: false,
      hasEpochGrant: false,
    },
  ]);
});

test("parsePeerDevices keeps optional display fields", () => {
  expect(
    parsePeerDevices([
      {
        id: "00000000-0000-4000-8000-000000000041",
        encryptionPublicKey: "aa",
        signingPublicKey: "bb",
        hasEpochGrant: true,
        name: "CatchOS Main PC",
        clientKind: "cli",
        osName: "Linux",
        clientSummary: "dotrelay-cli",
      },
    ]),
  ).toEqual([
    {
      id: "00000000-0000-4000-8000-000000000041",
      encryptionPublicKey: "aa",
      signingPublicKey: "bb",
      hasEpochGrant: true,
      name: "CatchOS Main PC",
      clientKind: "cli",
      osName: "Linux",
      clientSummary: "dotrelay-cli",
    },
  ]);
});

test("an owed rotation is kept only when it is well formed and names a cause", () => {
  const owed = {
    since: "2026-11-12T09:30:00.000Z",
    sinceEpoch: "3",
    membershipRemovals: 1,
    deviceRevocations: 0,
  };
  expect(parseRotationOwed(owed)).toEqual(owed);
  expect(parseRotationOwed(null)).toBeNull();
  expect(parseRotationOwed(undefined)).toBeNull();
  expect(parseRotationOwed({ ...owed, since: "yesterday" })).toBeNull();
  expect(parseRotationOwed({ ...owed, sinceEpoch: 3 })).toBeNull();
  expect(parseRotationOwed({ ...owed, membershipRemovals: -1 })).toBeNull();
  expect(parseRotationOwed({ ...owed, membershipRemovals: 0 })).toBeNull();
});

test("the owed rotation's cause names removals and revocations", () => {
  const base = { since: "2026-11-12T09:30:00.000Z", sinceEpoch: "3" };
  expect(
    rotationOwedCause({ ...base, membershipRemovals: 1, deviceRevocations: 0 }),
  ).toBe("1 member removed");
  expect(
    rotationOwedCause({ ...base, membershipRemovals: 0, deviceRevocations: 2 }),
  ).toBe("2 devices revoked");
  expect(
    rotationOwedCause({ ...base, membershipRemovals: 3, deviceRevocations: 1 }),
  ).toBe("3 members removed and 1 device revoked");
});
