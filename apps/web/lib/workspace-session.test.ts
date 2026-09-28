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

test("the refresh loop repeats on the short setup interval", async () => {
  const run = harness(40);
  try {
    await Bun.sleep(300);
    expect(run.calls()).toBeGreaterThanOrEqual(3);
  } finally {
    run.dispose();
  }
});
