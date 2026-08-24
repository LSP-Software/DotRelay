import { describe, expect, test } from "bun:test";
import { createCapabilitiesDocument } from "./api";
import type { ContractError } from "./errors";
import {
  establishServerProfileTrust,
  type ServerProfileTrustError,
} from "./server-profile";

const origin = "https://relay.example";
const serverProfileId = "00000000-0000-4000-8000-000000000042";
const capabilities = createCapabilitiesDocument({ origin, serverProfileId });

describe("Server Profile client trust", () => {
  test("pins the canonical response origin and immutable profile id", async () => {
    const trusted = await establishServerProfileTrust(capabilities, {
      requestedOrigin: origin,
    });

    expect(trusted.pin).toEqual({ origin, serverProfileId });
  });

  test("fails closed on redirects and profile identity changes", async () => {
    await expect(
      establishServerProfileTrust(capabilities, {
        requestedOrigin: "https://redirected.example",
      }),
    ).rejects.toMatchObject<Partial<ServerProfileTrustError>>({
      code: "origin_mismatch",
    });

    await expect(
      establishServerProfileTrust(capabilities, {
        requestedOrigin: origin,
        pinned: {
          origin,
          serverProfileId: "00000000-0000-4000-8000-000000000043",
        },
      }),
    ).rejects.toMatchObject<Partial<ServerProfileTrustError>>({
      code: "identity_changed",
    });
  });

  test("requires an explicit rebind when the same profile moves", async () => {
    const pinned = {
      origin: "https://old-relay.example",
      serverProfileId,
    };
    await expect(
      establishServerProfileTrust(capabilities, {
        requestedOrigin: origin,
        pinned,
      }),
    ).rejects.toMatchObject<Partial<ServerProfileTrustError>>({
      code: "rebind_required",
    });

    const rebound = await establishServerProfileTrust(capabilities, {
      requestedOrigin: origin,
      pinned,
      allowRebind: true,
    });
    expect(rebound.pin).toEqual({ origin, serverProfileId });
  });

  test("rejects an unsupported suite before checking runtime support", async () => {
    const unsupported = {
      ...capabilities,
      suite: { ...capabilities.suite, value: 2 },
    };

    await expect(
      establishServerProfileTrust(unsupported, {
        requestedOrigin: origin,
        runtime: {} as Crypto,
      }),
    ).rejects.toMatchObject<Partial<ContractError>>({
      code: "unsupported_crypto_suite",
    });
  });

  test("does not read credentials until Server Profile trust succeeds", async () => {
    let credentialReads = 0;
    const connect = async () => {
      await establishServerProfileTrust(capabilities, {
        requestedOrigin: origin,
        runtime: {} as Crypto,
      });
      credentialReads += 1;
    };

    await expect(connect()).rejects.toMatchObject<Partial<ContractError>>({
      code: "unsupported_crypto_runtime",
    });
    expect(credentialReads).toBe(0);
  });
});
