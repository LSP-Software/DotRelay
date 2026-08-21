import { describe, expect, test } from "bun:test";
import { createInMemoryAuth } from "./auth";
import { app, createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

describe("API foundation", () => {
  test("exposes a health endpoint", async () => {
    const response = await app.request("http://localhost/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("publishes a profile-bound capabilities document with an ETag", async () => {
    const response = await app.request("http://localhost/api/v1/capabilities");
    const capabilities = await response.json();

    expect(response.status).toBe(200);
    expect(capabilities).toMatchObject({
      serverProfileId: "00000000-0000-4000-8000-000000000001",
      origin: "http://localhost:3001",
      apiVersion: "v1",
      suite: { value: 3 },
    });
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, must-revalidate",
    );

    const cached = await app.request("http://localhost/api/v1/capabilities", {
      headers: { "If-None-Match": response.headers.get("etag") ?? "" },
    });
    expect(cached.status).toBe(304);
  });

  test("rejects an untrusted origin and mixed cookie/bearer credentials", async () => {
    const originResponse = await app.request(
      "http://localhost/api/v1/capabilities",
      {
        headers: { Origin: "https://attacker.example" },
      },
    );
    expect(originResponse.status).toBe(403);

    const mixedResponse = await app.request("http://localhost/api/v1/session", {
      headers: {
        Authorization: "Bearer token",
        Cookie: "better-auth.session_token=session",
      },
    });
    expect(mixedResponse.status).toBe(401);
    expect(await mixedResponse.json()).toMatchObject({
      code: "authentication_required",
    });
  });

  test("requires an Origin on cookie-authenticated state changes", async () => {
    const response = await app.request("http://localhost/api/auth/sign-out", {
      method: "POST",
      headers: { Cookie: "better-auth.session_token=session" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  test("keeps auth CORS exact and exposes the device flow", async () => {
    const profile = loadServerProfileConfig({});
    const auth = createInMemoryAuth(profile);
    const testApp = createApi({
      database: {} as never,
      profile,
      auth,
    });
    const response = await testApp.request(
      "http://localhost:3001/api/auth/device/code",
      {
        method: "POST",
        headers: {
          Origin: profile.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: "dotrelay-cli" }),
      },
    );
    const device = (await response.json()) as {
      device_code: string;
      verification_uri: string;
      interval: number;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      profile.origin,
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(device).toMatchObject({
      verification_uri: `${profile.origin}/device`,
      interval: expect.any(Number),
    });

    const tokenResponse = await testApp.request(
      "http://localhost:3001/api/auth/device/token",
      {
        method: "POST",
        headers: {
          Origin: profile.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: "dotrelay-cli",
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    );
    expect(tokenResponse.status).toBe(400);
    expect(await tokenResponse.json()).toMatchObject({
      error: "authorization_pending",
    });
  });

  test("serves the device verification page without reflecting markup", async () => {
    const response = await app.request(
      "http://localhost:3001/device?user_code=%3Cscript%3E",
    );
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("<strong><script>");
  });
});
