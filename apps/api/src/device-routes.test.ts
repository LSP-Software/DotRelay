import { describe, expect, test } from "bun:test";
import {
  type CborValue,
  ContractError,
  canonicalEncode,
  FIELD_REGISTRY,
  isSignedField,
  OBJECT_REGISTRY,
  protocolObjectFromFields,
} from "@dotrelay/contracts";
import { createInMemoryAuth } from "./auth";
import { parseProtocolPayload } from "./device-routes";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const encodeBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe("Device and Account Key API payload parsers", () => {
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
      "/api/v1/account-keys/wrappers",
      "/api/v1/account-keys/wrappers/revoke",
      "/api/v1/account-keys/envelopes",
      "/api/v1/account-keys/transfers",
      "/api/v1/account-keys/transfers/00000000000000000000000000000000/accept",
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

// Build a structurally complete, self-signed kind-20 Account Key Wrapper for
// the wire-gate tests. Mirrors the frozen-vector fixture builder: every
// required field gets a well-formed value, the password-wrapper KDF fields
// default to an in-policy Argon2id, field 3 is the canonical encoding of the
// unsigned body and field 4 a fixed-length signature placeholder. `overrides`
// let a case flip a single field (version, KDF cost, KDF name) to probe the
// v1->v2 and KDF-policy gates.
const wrapperFieldValue = (field: number): CborValue => {
  const definition = FIELD_REGISTRY[field];
  if (!definition) throw new Error(`unknown field ${field}`);
  if (definition.type === "uint") {
    if (field === 88) return 2; // account key wrapper format version
    if (field === 71) return 32;
    if (field === 72) return 48;
    return 1;
  }
  const length =
    definition.exactLength ?? (field === 47 ? 48 : (definition.maxLength ?? 0));
  return new Uint8Array(length);
};

const buildWrapperBytes = (
  overrides: ReadonlyMap<number, CborValue> = new Map(),
): Uint8Array => {
  const definition = OBJECT_REGISTRY[20];
  if (!definition) throw new Error("kind 20 not registered");
  const fields = new Map<number, CborValue>();
  for (const field of definition.requiredFields)
    if (field > 2 && !isSignedField(field))
      fields.set(field, wrapperFieldValue(field));
  fields.set(86, 2); // wrapperType = PASSWORD
  fields.set(89, 1); // kdfName = ARGON2ID
  fields.set(90, 65536); // in-policy memory
  fields.set(91, 3); // in-policy iterations
  fields.set(92, 1); // in-policy parallelism
  for (const [field, value] of overrides) fields.set(field, value);
  const unsigned = canonicalEncode(protocolObjectFromFields(20, fields));
  fields.set(3, unsigned);
  fields.set(4, new Uint8Array(64));
  return canonicalEncode(protocolObjectFromFields(20, fields));
};

const wrapperPayload = (bytes: Uint8Array) =>
  parseProtocolPayload(
    {
      objectId: "11111111-1111-4111-8111-111111111111",
      object: encodeBase64(bytes),
    },
    "objectId",
    "object",
    20,
  );

describe("Account Key Wrapper ingest wire gates", () => {
  test("accepts a v2 password wrapper with an in-policy KDF", async () => {
    const payload = await wrapperPayload(buildWrapperBytes());
    expect(payload.kind).toBe(20);
    expect(payload.object.get(88)).toBe(2);
  });

  test("rejects a version-1 wrapper at the wire gate", async () => {
    await expect(
      wrapperPayload(buildWrapperBytes(new Map([[88, 1]]))),
    ).rejects.toMatchObject({ code: "invalid_crypto_object" });
  });

  test("rejects a password wrapper whose KDF exceeds the Argon2id policy", async () => {
    // memoryKiB beyond the policy ceiling
    await expect(
      wrapperPayload(buildWrapperBytes(new Map([[90, 524289]]))),
    ).rejects.toMatchObject({ code: "invalid_crypto_object" });
    // iterations beyond the policy ceiling
    await expect(
      wrapperPayload(buildWrapperBytes(new Map([[91, 11]]))),
    ).rejects.toMatchObject({ code: "invalid_crypto_object" });
    // parallelism beyond the policy ceiling
    await expect(
      wrapperPayload(buildWrapperBytes(new Map([[92, 17]]))),
    ).rejects.toMatchObject({ code: "invalid_crypto_object" });
  });

  test("rejects a password wrapper whose KDF name is not Argon2id", async () => {
    await expect(
      wrapperPayload(buildWrapperBytes(new Map([[89, 2]]))),
    ).rejects.toMatchObject({ code: "invalid_crypto_object" });
  });
});
