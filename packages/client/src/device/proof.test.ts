import { describe, expect, test } from "bun:test";
import {
  DEVICE_PROOF_CHALLENGE_BYTES,
  DEVICE_PROOF_TOKEN_BYTES,
  decodeDeviceProofValue,
  deviceProofMessage,
  encodeDeviceProofValue,
} from "@dotrelay/contracts";
import { createDeviceProofSession, sendWithDeviceProof } from "./proof";

const serverProfileId = "00000000-0000-4000-8000-000000000001";
const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";

const fixture = async (lifetimeSeconds = 300) => {
  const keys = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const calls: string[] = [];
  let issued = 0;
  let clock = 1_000_000;
  const exchange = async (
    path: string,
    body: Readonly<Record<string, unknown>>,
  ) => {
    calls.push(path);
    if (path === "/api/v1/devices/proofs/challenges") {
      expect(body).toEqual({});
      return {
        challenge: encodeDeviceProofValue(
          new Uint8Array(DEVICE_PROOF_CHALLENGE_BYTES).fill(7),
        ),
        expiresIn: 120,
      };
    }
    expect(body.deviceId).toBe(deviceId);
    const challenge = decodeDeviceProofValue(
      body.challenge,
      DEVICE_PROOF_CHALLENGE_BYTES,
    );
    const signature = Uint8Array.from(atob(String(body.signature)), (c) =>
      c.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        keys.publicKey,
        signature,
        deviceProofMessage({ serverProfileId, userId, deviceId, challenge }),
      ),
    ).toBe(true);
    issued += 1;
    return {
      token: encodeDeviceProofValue(
        new Uint8Array(DEVICE_PROOF_TOKEN_BYTES).fill(issued),
      ),
      deviceId,
      expiresIn: lifetimeSeconds,
    };
  };
  const session = createDeviceProofSession({
    deviceId,
    exchange,
    signer: async () => ({
      serverProfileId,
      userId,
      deviceId,
      signingKey: keys.privateKey,
    }),
    now: () => clock,
  });
  return {
    session,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
    tokenFor: (round: number) =>
      encodeDeviceProofValue(
        new Uint8Array(DEVICE_PROOF_TOKEN_BYTES).fill(round),
      ),
  };
};

describe("Device proof session", () => {
  test("signs the service's challenge and sends the proof with the Device claim", async () => {
    const { session, calls, tokenFor } = await fixture();
    expect(await session.headers()).toEqual({
      "X-DotRelay-Device-Id": deviceId,
      "X-DotRelay-Device-Proof": tokenFor(1),
    });
    expect(calls).toEqual([
      "/api/v1/devices/proofs/challenges",
      "/api/v1/devices/proofs",
    ]);
  });

  test("reuses a proof until it is close to expiry", async () => {
    const { session, calls, advance, tokenFor } = await fixture();
    await session.headers();
    advance(200_000);
    expect((await session.headers())["X-DotRelay-Device-Proof"]).toBe(
      tokenFor(1),
    );
    advance(80_000);
    expect((await session.headers())["X-DotRelay-Device-Proof"]).toBe(
      tokenFor(2),
    );
    expect(calls).toHaveLength(4);
  });

  test("concurrent requests share one exchange", async () => {
    const { session, calls } = await fixture();
    const results = await Promise.all([
      session.headers(),
      session.headers(),
      session.headers(),
    ]);
    expect(
      new Set(results.map((headers) => JSON.stringify(headers))).size,
    ).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("a refused proof is replaced, and the request is sent once more", async () => {
    const { session, tokenFor } = await fixture();
    const seen: string[] = [];
    const response = await sendWithDeviceProof(session, async (headers) => {
      seen.push(headers["X-DotRelay-Device-Proof"] ?? "");
      return { status: seen.length === 1 ? 401 : 200 };
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual([tokenFor(1), tokenFor(2)]);
  });

  test("a second refusal is returned, not retried forever", async () => {
    const { session } = await fixture();
    let sends = 0;
    const response = await sendWithDeviceProof(session, async () => {
      sends += 1;
      return { status: 401 };
    });
    expect(response.status).toBe(401);
    expect(sends).toBe(2);
  });

  test("invalidating a stale proof keeps the newer one", async () => {
    const { session, tokenFor } = await fixture();
    const first = await session.headers();
    session.invalidate(first);
    const second = await session.headers();
    expect(second["X-DotRelay-Device-Proof"]).toBe(tokenFor(2));
    session.invalidate(first);
    expect((await session.headers())["X-DotRelay-Device-Proof"]).toBe(
      tokenFor(2),
    );
  });

  test("refuses a signer for another Device and a proof for another Device", async () => {
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const wrongSigner = createDeviceProofSession({
      deviceId,
      exchange: async () => ({}),
      signer: async () => ({
        serverProfileId,
        userId,
        deviceId: "33333333-3333-4333-8333-333333333333",
        signingKey: keys.privateKey,
      }),
    });
    await expect(wrongSigner.headers()).rejects.toThrow("another Device");
    const wrongProof = createDeviceProofSession({
      deviceId,
      exchange: async (path) =>
        path.endsWith("/challenges")
          ? {
              challenge: encodeDeviceProofValue(
                new Uint8Array(DEVICE_PROOF_CHALLENGE_BYTES),
              ),
              expiresIn: 120,
            }
          : {
              token: encodeDeviceProofValue(
                new Uint8Array(DEVICE_PROOF_TOKEN_BYTES),
              ),
              deviceId: "33333333-3333-4333-8333-333333333333",
              expiresIn: 300,
            },
      signer: async () => ({
        serverProfileId,
        userId,
        deviceId,
        signingKey: keys.privateKey,
      }),
    });
    await expect(wrongProof.headers()).rejects.toThrow("different Device");
  });
});
