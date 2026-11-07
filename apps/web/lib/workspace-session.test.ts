import { expect, test } from "bun:test";
import { emptyWorkspaceBoundary } from "./workspace-boundary";
import {
  createWorkspaceRefreshLoop,
  loadWorkspaceSession,
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

// A boundary complete enough to reach the Device storage read, which fails
// in this runtime because no Device was ever enrolled, so the loader settles
// through its error path after at least one await.
const enrolledBoundary = () => {
  const base = onlineBoundary();
  return {
    ...base,
    profile: {
      ...base.profile,
      serverProfileId: "00000000-0000-4000-8000-000000000062",
    },
    device: {
      ...base.device,
      active: true,
      id: "00000000-0000-4000-8000-0000000000d1",
      encryptionPublicKey: "00",
      signingPublicKey: "00",
    },
    environment: {
      headRevision: "empty-environment",
      id: "env-1",
      projectId: "project-1",
      teamId: "team-1",
    },
  };
};

const sessionLoaderHarness = (cancellation: { current: boolean }) => {
  const removed: string[] = [];
  const staleWrites: boolean[] = [];
  let sessionWrites = 0;
  const done = loadWorkspaceSession(
    {
      boundary: enrolledBoundary(),
      profileId: "hosted",
      teamId: "team-1",
      projectId: "project-1",
      environmentId: "env-1",
      recoveryWrappers: [],
      recoveryActor: null,
      accountMasterKey: { get: () => null },
      durableBrowserDevice: { add: () => {} },
      removeSessionByKey: (key) => removed.push(key),
      setSessionsByKey: (update) => {
        sessionWrites += 1;
        update(new Map());
      },
      setContextStale: (stale) => staleWrites.push(stale),
    },
    cancellation,
  );
  return { done, removed, staleWrites, sessionWrites: () => sessionWrites };
};

test("a session load that is still current settles its selection", async () => {
  const run = sessionLoaderHarness({ current: false });
  await run.done;
  expect(run.removed).toHaveLength(1);
  expect(run.staleWrites).toEqual([false]);
});

test("a session load cancelled after it started writes no state", async () => {
  const cancellation = { current: false };
  const run = sessionLoaderHarness(cancellation);
  // The effect cleanup runs after the loader began awaiting; the flag must
  // reach the loader by reference, not as the value captured at the call.
  cancellation.current = true;
  await run.done;
  expect(run.removed).toEqual([]);
  expect(run.staleWrites).toEqual([]);
  expect(run.sessionWrites()).toBe(0);
});
