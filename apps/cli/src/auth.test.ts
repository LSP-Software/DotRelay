import { describe, expect, test } from "bun:test";
import type { ServerProfilePin } from "@dotrelay/contracts";
import {
  createSessionStore,
  loginWithDeviceAuthorization,
  openVerificationPage,
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

  test("exposes the validated URL, code, and expiry before polling", async () => {
    const credentials = {
      get: async () => null,
      set: async (_service: string, _account: string, _secret: Uint8Array) =>
        undefined,
      delete: async () => undefined,
    };
    const sessions = createSessionStore(credentials);
    let poll = 0;
    const seen: Array<
      Readonly<{ userCode: string; verificationUrl: string; expiresIn: number }>
    > = [];
    await loginWithDeviceAuthorization(profile, sessions, {
      sleep: async () => undefined,
      fetch: async () => {
        poll += 1;
        return poll === 1
          ? Response.json({
              device_code: "device-code",
              user_code: "KITE-MOSS",
              verification_uri: "https://relay.example/device",
              interval: 1,
              expires_in: 600,
            })
          : Response.json({
              access_token: "bearer-secret",
              token_type: "Bearer",
            });
      },
      open: async (url) => {
        seen.push({
          userCode: "KITE-MOSS",
          verificationUrl: url,
          expiresIn: 600,
        });
      },
      onAuthorization: (authorization, verificationUrl) => {
        seen.push({
          userCode: authorization.userCode,
          verificationUrl,
          expiresIn: authorization.expiresInSeconds,
        });
      },
    });
    // The authorization callback must fire (exposing the URL and expiry) before
    // the browser is launched and before any polling starts.
    expect(seen).toHaveLength(2);
    expect(seen[0]?.verificationUrl).toBe(
      "https://relay.example/device?user_code=KITE-MOSS",
    );
    expect(seen[0]?.userCode).toBe("KITE-MOSS");
    expect(seen[0]?.expiresIn).toBe(600);
    expect(seen[1]?.verificationUrl).toBe(
      "https://relay.example/device?user_code=KITE-MOSS",
    );
  });

  test("passes a server-supplied complete URL unchanged", async () => {
    const credentials = {
      get: async () => null,
      set: async (_service: string, _account: string, _secret: Uint8Array) =>
        undefined,
      delete: async () => undefined,
    };
    const sessions = createSessionStore(credentials);
    let poll = 0;
    let seenUrl = "";
    await loginWithDeviceAuthorization(profile, sessions, {
      noOpen: true,
      sleep: async () => undefined,
      fetch: async () => {
        poll += 1;
        return poll === 1
          ? Response.json({
              device_code: "device-code",
              user_code: "KITE-MOSS",
              verification_uri: "https://relay.example/device",
              verification_uri_complete:
                "https://relay.example/device?code=KITE-MOSS&next=1",
              interval: 1,
              expires_in: 600,
            })
          : Response.json({
              access_token: "bearer-secret",
              token_type: "Bearer",
            });
      },
      onAuthorization: (_authorization, verificationUrl) => {
        seenUrl = verificationUrl;
      },
    });
    expect(seenUrl).toBe("https://relay.example/device?code=KITE-MOSS&next=1");
  });

  test("keeps polling and surfaces the manual path when the launcher fails", async () => {
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
    let poll = 0;
    let failed = false;
    const result = await loginWithDeviceAuthorization(profile, sessions, {
      sleep: async () => undefined,
      fetch: async () => {
        poll += 1;
        if (poll === 1)
          return Response.json({
            device_code: "device-code",
            user_code: "KITE-MOSS",
            verification_uri: "https://relay.example/device",
            interval: 1,
            expires_in: 600,
          });
        if (poll === 2)
          return Response.json(
            { error: "authorization_pending" },
            { status: 400 },
          );
        return Response.json({
          access_token: "bearer-secret",
          token_type: "Bearer",
        });
      },
      open: async () => {
        throw new Error("no browser available");
      },
      onOpenFailed: () => {
        failed = true;
      },
    });
    expect(result.userCode).toBe("KITE-MOSS");
    expect(failed).toBe(true);
    expect(await sessions.get(profile)).toBe("bearer-secret");
  });

  test("reports an expired device authorization without a usable URL", async () => {
    const credentials = {
      get: async () => null,
      set: async (_service: string, _account: string, _secret: Uint8Array) =>
        undefined,
      delete: async () => undefined,
    };
    const sessions = createSessionStore(credentials);
    let poll = 0;
    let exposedBeforeWait = false;
    await expect(
      loginWithDeviceAuthorization(profile, sessions, {
        noOpen: true,
        sleep: async () => undefined,
        fetch: async () => {
          poll += 1;
          if (poll === 1)
            return Response.json({
              device_code: "device-code",
              user_code: "KITE-MOSS",
              verification_uri: "https://relay.example/device",
              interval: 1,
              expires_in: 600,
            });
          return Response.json({ error: "expired_token" }, { status: 400 });
        },
        onAuthorization: () => {
          exposedBeforeWait = poll === 1;
        },
      }),
    ).rejects.toThrow("device authorization expired");
    // The URL and code are exposed before the first poll, even on expiry.
    expect(exposedBeforeWait).toBe(true);
  });

  test("reports a denied device authorization", async () => {
    const credentials = {
      get: async () => null,
      set: async (_service: string, _account: string, _secret: Uint8Array) =>
        undefined,
      delete: async () => undefined,
    };
    const sessions = createSessionStore(credentials);
    let poll = 0;
    await expect(
      loginWithDeviceAuthorization(profile, sessions, {
        noOpen: true,
        sleep: async () => undefined,
        fetch: async () => {
          poll += 1;
          if (poll === 1)
            return Response.json({
              device_code: "device-code",
              user_code: "KITE-MOSS",
              verification_uri: "https://relay.example/device",
              interval: 1,
              expires_in: 600,
            });
          return Response.json({ error: "access_denied" }, { status: 400 });
        },
      }),
    ).rejects.toThrow("device authorization was denied");
  });
});

describe("CLI verification page launcher", () => {
  const url = "https://relay.example/device?user_code=KITE-MOSS";

  test("treats a nonzero launcher exit as a failure", async () => {
    await expect(
      openVerificationPage(url, () => ({ exited: Promise.resolve(1) }), 0),
    ).rejects.toThrow("could not open the verification page");
  });

  test("accepts a zero launcher exit", async () => {
    let command: readonly string[] = [];
    await openVerificationPage(
      url,
      (spawned) => {
        command = spawned;
        return { exited: Promise.resolve(0) };
      },
      0,
    );
    // The URL is handed to the launcher as a single argv element, never
    // re-parsed by a shell.
    expect(command).toHaveLength(2);
    expect(command[1]).toBe(url);
  });

  test("treats an unspawnable launcher as a failure", async () => {
    await expect(
      openVerificationPage(
        url,
        () => {
          throw new Error("launcher not installed");
        },
        0,
      ),
    ).rejects.toThrow("could not open the verification page");
  });

  test("keeps sign-in moving when the launcher stays running", async () => {
    const started = Date.now();
    await openVerificationPage(
      url,
      () => ({ exited: new Promise<number>(() => undefined) }),
      25,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
