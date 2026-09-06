import { expect, test } from "bun:test";
import {
  enrolledDeviceRows,
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
