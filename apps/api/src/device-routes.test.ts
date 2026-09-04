import { describe, expect, test } from "bun:test";
import {
  ContractError,
  canonicalEncode,
  protocolObjectFromFields,
} from "@dotrelay/contracts";
import { createInMemoryAuth } from "./auth";
import { parseProtocolPayload } from "./device-routes";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const encodeBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe("Device and Recovery API payload parsers", () => {
  test("rejects malformed base64 before touching persistence", async () => {
    await expect(
      parseProtocolPayload(
        { objectId: "11111111-1111-4111-8111-111111111111", object: "%%%" },
        "objectId",
        "object",
        5,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("requires the closed protocol object kind and complete signed envelope", async () => {
    const bytes = canonicalEncode(protocolObjectFromFields(5, new Map()));
    let error: unknown;
    try {
      await parseProtocolPayload(
        {
          objectId: "11111111-1111-4111-8111-111111111111",
          object: encodeBase64(bytes),
        },
        "objectId",
        "object",
        5,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe("invalid_crypto_object");
  });

  test("does not accept a valid object under the wrong endpoint kind", async () => {
    const bytes = canonicalEncode(protocolObjectFromFields(4, new Map()));
    await expect(
      parseProtocolPayload(
        {
          objectId: "11111111-1111-4111-8111-111111111111",
          object: encodeBase64(bytes),
        },
        "objectId",
        "object",
        5,
      ),
    ).rejects.toMatchObject({ code: "invalid_crypto_object" });
  });

  test("requires an authenticated active Device for every trust mutation", async () => {
    const profile = loadServerProfileConfig({});
    const api = createApi({
      database: {} as never,
      profile,
      auth: createInMemoryAuth(profile),
    });
    const endpoints = [
      "/api/v1/devices/enrollments",
      "/api/v1/devices/enrollments/11111111-1111-4111-8111-111111111111/approve",
      "/api/v1/devices/enrollments/11111111-1111-4111-8111-111111111111/complete",
      "/api/v1/recovery/envelopes",
      "/api/v1/recovery/attempts",
    ];
    for (const endpoint of endpoints) {
      const response = await api.request(`${profile.origin}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "authentication_required",
      });
    }
  });
});
