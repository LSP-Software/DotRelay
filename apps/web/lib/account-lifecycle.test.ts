import { afterEach, describe, expect, test } from "bun:test";
import { accountDeletionCommand } from "@dotrelay/contracts";
import {
  deleteAccount,
  downloadAccountExport,
  leaveTeam,
  lifecycleProblemMessage,
} from "./account-lifecycle";

// Account-level actions need this browser's Device while the account has an
// active one, and deleting the account needs the Device's signature over the
// exact command (ADR 0024).

const apiOrigin = "https://api.relay.example";
const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const teamId = "33333333-3333-4333-8333-333333333333";

type Sent = Readonly<{ url: string; headers: Headers; body: unknown }>;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const capture = (response: () => Response): Sent[] => {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return response();
  }) as typeof fetch;
  return sent;
};

describe("account deletion", () => {
  test("signs the exact deletion command with this browser's Device key", async () => {
    const keys = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const sent = capture(() => Response.json({ status: "DELETED" }));
    const result = await deleteAccount(apiOrigin, userId, {
      deviceId,
      signingKey: async () => keys.privateKey,
    });
    expect(result.ok).toBe(true);
    const [request] = sent;
    expect(request?.url).toBe(`${apiOrigin}/api/v1/account/delete`);
    expect(request?.headers.get("X-DotRelay-Device-Id")).toBe(deviceId);
    const operationId = request?.headers.get("Idempotency-Key") ?? "";
    const body = request?.body as { confirmUserId: string; signature: string };
    expect(body.confirmUserId).toBe(userId);
    const signature = Uint8Array.from(atob(body.signature), (character) =>
      character.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        keys.publicKey,
        signature,
        accountDeletionCommand({ userId, operationId }),
      ),
    ).toBe(true);
  });

  test("a browser without its Device key sends nothing", async () => {
    const sent = capture(() => Response.json({}));
    const result = await deleteAccount(apiOrigin, userId, {
      deviceId,
      signingKey: async () => null,
    });
    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("a browser without a Device sends only the confirmation", async () => {
    const sent = capture(() =>
      Response.json(
        { code: "recent_sign_in_required" },
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await deleteAccount(apiOrigin, userId);
    expect(sent[0]?.body).toEqual({ confirmUserId: userId });
    expect(sent[0]?.headers.has("X-DotRelay-Device-Id")).toBe(false);
    expect(result).toEqual({
      ok: false,
      message: lifecycleProblemMessage("recent_sign_in_required"),
    });
  });
});

describe("leaving a Team and exporting the account", () => {
  test("name this browser's Device so the request proves it", async () => {
    const sent = capture(() => Response.json({}));
    await leaveTeam(apiOrigin, teamId, deviceId);
    expect(sent[0]?.url).toBe(`${apiOrigin}/api/v1/teams/${teamId}/leave`);
    expect(sent[0]?.headers.get("X-DotRelay-Device-Id")).toBe(deviceId);
    globalThis.fetch = (async () =>
      Response.json(
        { code: "device_proof_required" },
        { status: 401 },
      )) as unknown as typeof fetch;
    const refused = await downloadAccountExport(apiOrigin);
    expect(refused).toEqual({
      ok: false,
      message: lifecycleProblemMessage(
        "device_proof_required",
        undefined,
        false,
      ),
    });
  });
});
