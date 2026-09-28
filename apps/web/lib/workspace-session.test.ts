import { expect, test } from "bun:test";
import { emptyWorkspaceBoundary } from "./workspace-boundary";
import {
  createWorkspaceRefreshLoop,
  workspaceBoundaryRefreshMs,
} from "./workspace-session";

const configuredRefreshMs = (): number =>
  Math.max(
    Number(process.env.NEXT_PUBLIC_DOTRELAY_WORKSPACE_REFRESH_MS ?? 0) ||
      30_000,
    1_000,
  );

test("an unfinished setup polls at most every two seconds", () => {
  const configured = configuredRefreshMs();
  expect(workspaceBoundaryRefreshMs(false)).toBe(configured);
  expect(workspaceBoundaryRefreshMs(true)).toBe(Math.min(configured, 2_000));
});

const onlineBoundary = () =>
  emptyWorkspaceBoundary("hosted", {
    connection: "online",
    origin: "http://127.0.0.1:9",
    session: { active: true, userId: "user-1" },
  });

const harness = (refreshMs: number) => {
  let calls = 0;
  const fetchImpl = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(onlineBoundary()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const loop = createWorkspaceRefreshLoop({
    profileId: "hosted",
    teamId: null,
    projectId: null,
    environmentId: null,
    boundary: onlineBoundary(),
    recoveryWrappers: [],
    accountUnlocked: false,
    apiOrigin: "http://127.0.0.1:9",
    boundaryJson: {
      get: () => "",
      set: () => {},
    },
    accountMasterKey: { get: () => null },
    refreshMs,
    reconnectNowRef: { current: null },
    setConnection: () => {},
    setVerifiedAt: () => {},
    setBoundary: () => {},
    removeSessionByKey: () => {},
  });
  return {
    calls: () => calls,
    dispose: () => {
      loop.dispose();
      globalThis.fetch = fetchImpl;
    },
  };
};

test("the refresh loop does not poll again before its interval", async () => {
  const run = harness(5_000);
  try {
    await Bun.sleep(200);
    expect(run.calls()).toBe(1);
  } finally {
    run.dispose();
  }
});

test("a newer refresh is not overwritten by an older in-flight boundary", async () => {
  const fetchImpl = globalThis.fetch;
  let releaseDisplay: (response: Response) => void = () => {};
  const heldDisplay = new Promise<Response>((resolve) => {
    releaseDisplay = resolve;
  });
  const browserDevice = {
    active: true,
    id: "00000000-0000-4000-8000-000000000099",
    label: "Browser",
  };
  const empty = { ...onlineBoundary(), device: browserDevice };
  const withCli = {
    ...empty,
    peerDevices: [
      {
        id: "00000000-0000-4000-8000-000000000041",
        encryptionPublicKey: "11".repeat(32),
        signingPublicKey: "22".repeat(32),
        hasEpochGrant: false,
        clientKind: "cli",
      },
    ],
  };
  let displays = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/devices/self")) {
      displays += 1;
      if (displays === 1) return heldDisplay;
      return new Response(null, { status: 204 });
    }
    const body = displays === 0 ? empty : withCli;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const seen: string[] = [];
  const loop = createWorkspaceRefreshLoop({
    profileId: "hosted",
    teamId: null,
    projectId: null,
    environmentId: null,
    boundary: empty,
    recoveryWrappers: [],
    accountUnlocked: false,
    apiOrigin: "http://127.0.0.1:9",
    boundaryJson: {
      get: () => seen.at(-1) ?? "",
      set: (value) => {
        seen.push(value);
      },
    },
    accountMasterKey: { get: () => null },
    refreshMs: 60_000,
    reconnectNowRef: { current: null },
    setConnection: () => {},
    setVerifiedAt: () => {},
    setBoundary: () => {},
    removeSessionByKey: () => {},
  });
  try {
    for (let attempt = 0; attempt < 20 && displays < 1; attempt += 1)
      await Bun.sleep(10);
    expect(displays).toBe(1);
    loop.reconnectNow();
    for (let attempt = 0; attempt < 20 && seen.length < 1; attempt += 1)
      await Bun.sleep(10);
    releaseDisplay(new Response(null, { status: 204 }));
    await Bun.sleep(30);
    expect(seen.at(-1)).toContain('"clientKind":"cli"');
  } finally {
    loop.dispose();
    globalThis.fetch = fetchImpl;
  }
});

test("the refresh loop repeats on the short setup interval", async () => {
  const run = harness(40);
  try {
    await Bun.sleep(300);
    expect(run.calls()).toBeGreaterThanOrEqual(3);
  } finally {
    run.dispose();
  }
});
