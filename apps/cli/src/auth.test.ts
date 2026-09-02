import { describe, expect, test } from "bun:test";
import type { ServerProfilePin } from "@dotrelay/contracts";
import {
  createSessionStore,
  loginWithDeviceAuthorization,
  verificationPageCommand,
} from "./auth";

const profile: ServerProfilePin = {
  origin: "https://relay.example",
  serverProfileId: "00000000-0000-4000-8000-000000000042",
};

describe("CLI device authorization", () => {
  test("uses printable profile-scoped native credential accounts", async () => {
    let account = "";
    const credentials = {
      get: async () => null,
      set: async (_service: string, value: string) => {
        account = value;
      },
      delete: async () => undefined,
    };
    await createSessionStore(credentials).save(profile, "session-token");
    expect(account).not.toContain("\0");
    expect(account).toContain("v1:");
  });

  test("migrates a legacy session account", async () => {
    const secrets = new Map<string, Uint8Array>();
    const legacy = `${profile.origin}\0${profile.serverProfileId}`;
    secrets.set(legacy, new TextEncoder().encode("legacy-token"));
    const credentials = {
      get: async (_service: string, account: string) =>
        secrets.get(account) ?? null,
      set: async (_service: string, account: string, secret: Uint8Array) =>
        void secrets.set(account, secret),
      delete: async (_service: string, account: string) =>
        void secrets.delete(account),
    };
    const sessions = createSessionStore(credentials);
    expect(await sessions.get(profile)).toBe("legacy-token");
    expect(
      [...secrets.keys()].some((account) => account.startsWith("v1:")),
    ).toBe(true);
  });

  test("uses the server polling interval and stores only the bearer session", async () => {
    const secrets = new Map<string, Uint8Array>();
    const credentials = {
      get: async (_service: string, account: string) =>
        secrets.get(account) ?? null,
      set: async (_service: string, account: string, secret: Uint8Array) =>
        void secrets.set(account, secret),
      delete: async (_service: string, account: string) =>
        void secrets.delete(account),
    };
    const sessions = createSessionStore(credentials);
    const calls: string[] = [];
    const waits: number[] = [];
    let poll = 0;
    const result = await loginWithDeviceAuthorization(profile, sessions, {
      noOpen: true,
      sleep: async (milliseconds) => void waits.push(milliseconds),
      fetch: async (input, init) => {
        calls.push(String(input));
        if (calls.length === 1)
          return Response.json({
            device_code: "device-code",
            user_code: "KITE-MOSS",
            verification_uri: "https://relay.example/device",
            interval: 7,
            expires_in: 60,
          });
        poll += 1;
        if (poll === 1)
          expect(JSON.parse(String(init?.body))).toMatchObject({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          });
        return poll === 1
          ? Response.json({ error: "authorization_pending" }, { status: 400 })
          : Response.json({
              access_token: "bearer-secret",
              token_type: "Bearer",
            });
      },
    });
    expect(result.userCode).toBe("KITE-MOSS");
    expect(waits).toEqual([7000, 7000]);
    expect(await sessions.get(profile)).toBe("bearer-secret");
    expect(calls[0]).toContain("/device/code");
    expect(calls[1]).toContain("/device/token");
  });

  test("passes a Windows verification URL without shell interpretation", () => {
    const url = 'https://relay.example/device?value="quoted"&next=1';
    expect(verificationPageCommand("win32", url)).toEqual([
      "explorer.exe",
      url,
    ]);
  });

  test("rejects a verification URL from another origin", async () => {
    const credentials = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    };
    await expect(
      loginWithDeviceAuthorization(profile, createSessionStore(credentials), {
        noOpen: true,
        fetch: async () =>
          Response.json({
            device_code: "device-code",
            user_code: "ABCD-EFGH",
            verification_uri: "https://phishing.example/device",
          }),
      }),
    ).rejects.toThrow("does not belong to the Server Profile");
  });
});
