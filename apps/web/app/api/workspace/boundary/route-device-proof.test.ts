import { afterEach, beforeEach, expect, test } from "bun:test";
import { GET } from "./route";

// The relay forwards the browser's Device proof (ADR 0020) to the API, and a
// refused proof reaches the browser as a 401 so it gets a new one. Answering
// with the session view instead would read as "this browser has no Device".

const deviceId = "00000000-0000-4000-8000-0000000000d1";
const apiOrigin = "https://api.relay.example";
const saved = {
  fetch: globalThis.fetch,
  apiOrigin: process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN,
  fixture: process.env.DOTRELAY_WORKSPACE_FIXTURE,
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN = apiOrigin;
  delete process.env.DOTRELAY_WORKSPACE_FIXTURE;
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  if (saved.apiOrigin === undefined)
    delete process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN;
  else process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN = saved.apiOrigin;
  if (saved.fixture === undefined)
    delete process.env.DOTRELAY_WORKSPACE_FIXTURE;
  else process.env.DOTRELAY_WORKSPACE_FIXTURE = saved.fixture;
});

const stubApi = (boundary: () => Response) => {
  const forwarded: Array<Record<string, string | null>> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/v1/session")
      return Response.json({ authenticated: true, user: { id: "user" } });
    if (url.pathname === "/api/v1/capabilities")
      return Response.json({ serverProfileId: crypto.randomUUID() });
    // A server without GITHUB_APP_SLUG has no install link.
    if (url.pathname === "/api/v1/github-app")
      return Response.json({ code: "resource_not_found" }, { status: 404 });
    forwarded.push({
      device: headers.get("X-DotRelay-Device-Id"),
      proof: headers.get("X-DotRelay-Device-Proof"),
      cookie: headers.get("cookie"),
    });
    return boundary();
  }) as typeof fetch;
  return forwarded;
};

const browserRequest = (proof?: string) =>
  new Request("https://relay.example/api/workspace/boundary?profile=hosted", {
    headers: {
      cookie: "session=browser",
      ...(proof
        ? {
            "X-DotRelay-Device-Id": deviceId,
            "X-DotRelay-Device-Proof": proof,
          }
        : {}),
    },
  });

test("forwards the Device proof with the session cookie", async () => {
  const forwarded = stubApi(() =>
    Response.json({ device: { active: true, id: deviceId } }),
  );
  const response = await GET(browserRequest("proof-token"));
  expect(response.status).toBe(200);
  expect(forwarded).toEqual([
    { device: deviceId, proof: "proof-token", cookie: "session=browser" },
  ]);
});

test("passes a refused Device proof through as a 401", async () => {
  stubApi(() =>
    Response.json(
      { code: "device_proof_required", status: 401 },
      { status: 401 },
    ),
  );
  const response = await GET(browserRequest("expired-proof"));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ code: "device_proof_required" });
});

test("a request without a proof still gets the session view", async () => {
  const forwarded = stubApi(() => Response.json({ device: { active: false } }));
  const response = await GET(browserRequest());
  expect(response.status).toBe(200);
  const body = (await response.json()) as { device: { active: boolean } };
  expect(body.device.active).toBe(false);
  expect(forwarded[0]?.proof).toBeNull();
});
