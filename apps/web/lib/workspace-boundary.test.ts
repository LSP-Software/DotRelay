import { expect, test } from "bun:test";
import {
  e2eWorkspaceBoundary,
  emptyWorkspaceBoundary,
  enrolledDeviceRows,
  fetchWorkspaceBoundary,
  parsePeerDevices,
  parseWorkspaceCatalog,
  projectDisplayName,
  resolveLiveApiOrigin,
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
  expect(boundary.session).toEqual({ active: true, displayName: "Ari Stone" });
  expect(boundary.environment.id).toBe("00000000-0000-4000-8000-000000000031");
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
        device: { active: true, id: "00000000-0000-4000-8000-000000000040" },
        grantsReady: true,
        peerDevices: [
          {
            id: "00000000-0000-4000-8000-000000000041",
            encryptionPublicKey: "aa",
            signingPublicKey: "bb",
            hasEpochGrant: false,
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
    },
    {
      id: "00000000-0000-4000-8000-000000000041",
      current: false,
      hasEpochGrant: false,
    },
  ]);
});
