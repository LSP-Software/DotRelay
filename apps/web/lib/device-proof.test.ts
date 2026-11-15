import { afterEach, expect, test } from "bun:test";
import {
  DeviceProofRequestError,
  fetchWithDeviceProof,
  isDeviceUnavailable,
} from "./device-proof";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const deviceId = "00000000-0000-4000-8000-0000000000d1";

test("a proven request carries one Device claim and the proof, and replaces a refused proof once", async () => {
  const seen: Array<Readonly<{ device: string | null; proof: string | null }>> =
    [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      device: headers.get("X-DotRelay-Device-Id"),
      proof: headers.get("X-DotRelay-Device-Proof"),
    });
    return new Response(null, { status: seen.length === 1 ? 401 : 204 });
  }) as typeof fetch;
  let round = 0;
  const session = {
    deviceId,
    headers: async () => ({
      "X-DotRelay-Device-Id": deviceId,
      "X-DotRelay-Device-Proof": `proof-${round}`,
    }),
    invalidate: () => {
      round += 1;
    },
  };
  const response = await fetchWithDeviceProof(
    session,
    "https://api.relay.example/api/v1/account-keys/envelopes",
    // The caller's own claim must not be sent twice.
    { headers: { "x-dotrelay-device-id": deviceId } },
  );
  expect(response.status).toBe(204);
  expect(seen).toEqual([
    { device: deviceId, proof: "proof-0" },
    { device: deviceId, proof: "proof-1" },
  ]);
});

test("a request without a proof session goes out unproven", async () => {
  let proof: string | null = "unset";
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    proof = new Headers(init?.headers).get("X-DotRelay-Device-Proof");
    return new Response(null, { status: 401 });
  }) as typeof fetch;
  const response = await fetchWithDeviceProof(
    undefined,
    "https://api.relay.example/api/v1/account-keys/envelopes",
  );
  expect(response.status).toBe(401);
  expect(proof).toBeNull();
});

test("only a refused or keyless Device reads as no Device", () => {
  for (const code of [
    "device_not_active",
    "invalid_crypto_object",
    "device_bundle_missing",
  ])
    expect(isDeviceUnavailable(new DeviceProofRequestError(code))).toBe(true);
  for (const code of ["authentication_required", "rate_limited", null])
    expect(isDeviceUnavailable(new DeviceProofRequestError(code))).toBe(false);
  expect(isDeviceUnavailable(new TypeError("Failed to fetch"))).toBe(false);
});
