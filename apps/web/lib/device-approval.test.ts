import { expect, test } from "bun:test";
import {
  attemptDeviceApproval,
  checkDeviceStatus,
  checkServerProfileSession,
  type DeviceStatusCheck,
  deviceApprovalAttemptView,
  deviceApprovalView,
  parseDeviceApprovalAttempt,
  parseDeviceStatusResponse,
  parseSessionResponse,
  type SessionCheck,
} from "./device-approval";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const statusResponse = (body: unknown, status = 200) =>
  parseDeviceStatusResponse({ ok: status < 400, status }, body);

test("parses pending, approved, and denied code statuses", () => {
  expect(statusResponse({ user_code: "ABCDEFGH", status: "pending" })).toEqual({
    kind: "code",
    status: "pending",
  });
  expect(statusResponse({ user_code: "ABCDEFGH", status: "approved" })).toEqual(
    {
      kind: "code",
      status: "approved",
    },
  );
  expect(statusResponse({ user_code: "ABCDEFGH", status: "denied" })).toEqual({
    kind: "code",
    status: "denied",
  });
});

test("parses expired and invalid codes as distinct terminal states", () => {
  expect(statusResponse({ error: "expired_token" }, 400)).toEqual({
    kind: "expired",
  });
  expect(statusResponse({ error: "invalid_request" }, 400)).toEqual({
    kind: "invalid",
  });
});

test("treats unknown or missing status information as a connection failure", () => {
  expect(statusResponse({ error: "expired_token" }, 401)).toEqual({
    kind: "unavailable",
  });
  expect(statusResponse({ code: "service_unavailable" }, 503)).toEqual({
    kind: "unavailable",
  });
  expect(statusResponse(null, 200)).toEqual({ kind: "unavailable" });
  expect(statusResponse({ status: "surprising" }, 200)).toEqual({
    kind: "unavailable",
  });
});

test("parses the browser session from get-session", () => {
  const sessionResponse = (body: unknown, status = 200) =>
    parseSessionResponse({ ok: status < 400, status }, body);
  expect(sessionResponse(null)).toEqual({ kind: "signed-out" });
  expect(
    sessionResponse({
      session: { token: "session-token" },
      user: { id: "user-id" },
    }),
  ).toEqual({ kind: "signed-in" });
  expect(sessionResponse({}, 200)).toEqual({ kind: "unavailable" });
  expect(sessionResponse(null, 503)).toEqual({ kind: "unavailable" });
});

test("parses approval outcomes into retryable and terminal states", () => {
  const attemptResponse = (body: unknown, status: number) =>
    parseDeviceApprovalAttempt({ ok: status < 400, status }, body);
  expect(attemptResponse({ success: true }, 200)).toEqual({ kind: "approved" });
  expect(attemptResponse({ error: "expired_token" }, 400)).toEqual({
    kind: "expired",
  });
  expect(attemptResponse({ error: "invalid_request" }, 400)).toEqual({
    kind: "stale",
  });
  expect(attemptResponse({ error: "unauthorized" }, 401)).toEqual({
    kind: "signed-out",
  });
  expect(attemptResponse({ error: "access_denied" }, 403)).toEqual({
    kind: "forbidden",
  });
  expect(attemptResponse({ error: "expired_token" }, 401)).toEqual({
    kind: "unavailable",
  });
  expect(attemptResponse({ code: "service_unavailable" }, 503)).toEqual({
    kind: "unavailable",
  });
});

test("maps code and session checks to the approval view", () => {
  const pending: DeviceStatusCheck = { kind: "code", status: "pending" };
  const signedIn: SessionCheck = { kind: "signed-in" };
  const signedOut: SessionCheck = { kind: "signed-out" };
  const unreachable: SessionCheck = { kind: "unavailable" };

  expect(deviceApprovalView(pending, signedIn)).toEqual({ kind: "allow" });
  expect(deviceApprovalView(pending, signedOut)).toEqual({ kind: "sign-in" });
  expect(deviceApprovalView(pending, unreachable)).toEqual({
    kind: "connection",
  });
  expect(
    deviceApprovalView({ kind: "code", status: "approved" }, signedOut),
  ).toEqual({ kind: "approved" });
  expect(
    deviceApprovalView({ kind: "code", status: "denied" }, signedOut),
  ).toEqual({ kind: "declined" });
  expect(deviceApprovalView({ kind: "expired" }, signedIn)).toEqual({
    kind: "expired",
  });
  expect(deviceApprovalView({ kind: "invalid" }, signedOut)).toEqual({
    kind: "invalid",
  });
  expect(deviceApprovalView({ kind: "unavailable" }, signedIn)).toEqual({
    kind: "connection",
  });
});

test("maps approval outcomes to views or a re-check", () => {
  expect(deviceApprovalAttemptView({ kind: "approved" })).toEqual({
    kind: "approved",
  });
  expect(deviceApprovalAttemptView({ kind: "expired" })).toEqual({
    kind: "expired",
  });
  expect(deviceApprovalAttemptView({ kind: "forbidden" })).toEqual({
    kind: "forbidden",
  });
  expect(deviceApprovalAttemptView({ kind: "unavailable" })).toEqual({
    kind: "connection",
  });
  expect(deviceApprovalAttemptView({ kind: "stale" })).toBeUndefined();
  expect(deviceApprovalAttemptView({ kind: "signed-out" })).toBeUndefined();
});

type StubFetch = (input: string, init?: RequestInit) => Promise<Response>;

const routeFetch = (
  routes: Readonly<Record<string, (init?: RequestInit) => Response>>,
): { fetcher: StubFetch; readonly calls: string[] } => {
  const calls: string[] = [];
  const fetcher: StubFetch = (input, init) => {
    calls.push(input);
    const method = init?.method ?? "GET";
    const key = `${method} ${input}`;
    const route = routes[key];
    if (!route) return Promise.reject(new TypeError(`unrouted ${key}`));
    return Promise.resolve(route(init));
  };
  return { fetcher, calls };
};

test("a network failure while checking degrades to a retryable connection state", async () => {
  const throwing: StubFetch = () =>
    Promise.reject(new TypeError("network down"));
  const [status, session] = await Promise.all([
    checkDeviceStatus("http://localhost:3001", "ABCDEFGH", throwing),
    checkServerProfileSession("http://localhost:3001", throwing),
  ]);
  expect(status).toEqual({ kind: "unavailable" });
  expect(session).toEqual({ kind: "unavailable" });
  expect(deviceApprovalView(status, session)).toEqual({ kind: "connection" });
});

test("a network failure while approving preserves the code as retryable", async () => {
  const throwing: StubFetch = () =>
    Promise.reject(new TypeError("network down"));
  expect(
    await attemptDeviceApproval("http://localhost:3001", "ABCDEFGH", throwing),
  ).toEqual({ kind: "unavailable" });
});

test("non-JSON error bodies degrade to a retryable connection state", async () => {
  const { fetcher } = routeFetch({
    "GET http://localhost:3001/api/auth/device?user_code=AB%20C": () =>
      new Response("proxy error", { status: 502 }),
    "GET http://localhost:3001/api/auth/get-session": () =>
      new Response("proxy error", { status: 502 }),
  });
  expect(
    await checkDeviceStatus("http://localhost:3001", "AB C", fetcher),
  ).toEqual({ kind: "unavailable" });
  expect(
    await checkServerProfileSession("http://localhost:3001", fetcher),
  ).toEqual({ kind: "unavailable" });
});

test("checks query the device and session endpoints with credentials", async () => {
  const { fetcher, calls } = routeFetch({
    "GET http://localhost:3001/api/auth/device?user_code=ABCDEFGH": () =>
      jsonResponse(200, { user_code: "ABCDEFGH", status: "pending" }),
    "GET http://localhost:3001/api/auth/get-session": () =>
      jsonResponse(200, {
        session: { token: "session-token" },
        user: { id: "user-id" },
      }),
  });
  const [status, session] = await Promise.all([
    checkDeviceStatus("http://localhost:3001", "ABCDEFGH", fetcher),
    checkServerProfileSession("http://localhost:3001", fetcher),
  ]);
  expect(calls).toEqual([
    "http://localhost:3001/api/auth/device?user_code=ABCDEFGH",
    "http://localhost:3001/api/auth/get-session",
  ]);
  expect(status).toEqual({ kind: "code", status: "pending" });
  expect(session).toEqual({ kind: "signed-in" });
  expect(deviceApprovalView(status, session)).toEqual({ kind: "allow" });
});

test("approval posts the user code to the approve endpoint", async () => {
  const { fetcher, calls } = routeFetch({
    "POST http://localhost:3001/api/auth/device/approve": (init) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual(
        expect.objectContaining({ "Content-Type": "application/json" }),
      );
      expect(init?.body).toBe(JSON.stringify({ userCode: "ABCDEFGH" }));
      return jsonResponse(200, { success: true });
    },
  });
  const attempt = await attemptDeviceApproval(
    "http://localhost:3001",
    "ABCDEFGH",
    fetcher,
  );
  expect(calls).toEqual(["http://localhost:3001/api/auth/device/approve"]);
  expect(attempt).toEqual({ kind: "approved" });
  expect(deviceApprovalAttemptView(attempt)).toEqual({ kind: "approved" });
});

test("a signed-out approval lands on the sign-in view through a re-check", async () => {
  const { fetcher } = routeFetch({
    "POST http://localhost:3001/api/auth/device/approve": () =>
      jsonResponse(401, { error: "unauthorized" }),
    "GET http://localhost:3001/api/auth/device?user_code=ABCDEFGH": () =>
      jsonResponse(200, { user_code: "ABCDEFGH", status: "pending" }),
    "GET http://localhost:3001/api/auth/get-session": () =>
      jsonResponse(200, null),
  });
  const attempt = await attemptDeviceApproval(
    "http://localhost:3001",
    "ABCDEFGH",
    fetcher,
  );
  expect(deviceApprovalAttemptView(attempt)).toBeUndefined();
  const [status, session] = await Promise.all([
    checkDeviceStatus("http://localhost:3001", "ABCDEFGH", fetcher),
    checkServerProfileSession("http://localhost:3001", fetcher),
  ]);
  expect(deviceApprovalView(status, session)).toEqual({ kind: "sign-in" });
});
