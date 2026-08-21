import { describe, expect, test } from "bun:test";
import {
  API_VERSION,
  CBOR_LIMITS,
  type CborValue,
  canonicalDecode,
  canonicalEncode,
  createCapabilitiesDocument,
  createProblem,
  encodeProtocolObject,
  FIELD_REGISTRY,
  OBJECT_REGISTRY,
  OPENAPI_DOCUMENT,
  PROBLEM_STATUS,
  parseCapabilitiesDocument,
  parseJsonObject,
  parseProblem,
  parseProtocolObject,
  protocolObjectFromFields,
  SUITE_NAME,
  SUITE_VALUE,
  validateIdempotencyKey,
} from "@dotrelay/contracts";

const zeros = (length: number): Uint8Array => new Uint8Array(length);
const id = (value: number): Uint8Array => {
  const bytes = zeros(16);
  bytes[15] = value;
  return bytes;
};

const userIdentity = () =>
  protocolObjectFromFields(
    1,
    new Map<number, CborValue>([
      [8, id(1)],
      [9, id(2)],
      [28, 1],
      [32, 1],
      [39, zeros(32)],
      [41, zeros(32)],
    ]),
  );

describe("deterministic CBOR boundary", () => {
  test("encodes integer-keyed maps in deterministic order and decodes a copy", () => {
    const first = canonicalEncode(
      new Map<number, CborValue>([
        [1, "one"],
        [0, 2],
      ]),
    );
    const second = canonicalEncode(
      new Map<number, CborValue>([
        [0, 2],
        [1, "one"],
      ]),
    );

    expect(first).toEqual(second);
    expect(Array.from(first)).toEqual([162, 0, 2, 1, 99, 111, 110, 101]);
    expect(canonicalDecode(first)).toEqual(
      new Map<number, CborValue>([
        [0, 2],
        [1, "one"],
      ]),
    );
  });

  test("rejects noncanonical, unsupported, duplicate, and over-deep CBOR", () => {
    expect(() => canonicalDecode(Uint8Array.from([0x18, 0x01]))).toThrow(
      "invalid_crypto_object",
    );
    expect(() => canonicalDecode(Uint8Array.from([0xc0, 0x00]))).toThrow(
      "invalid_crypto_object",
    );
    expect(() =>
      canonicalDecode(Uint8Array.from([0xa2, 0x00, 0x01, 0x00, 0x02])),
    ).toThrow("invalid_crypto_object");
    expect(() => canonicalDecode(Uint8Array.from([0x9f, 0x01, 0xff]))).toThrow(
      "invalid_crypto_object",
    );
  });
});

describe("dotrelay-e2ee-v3 classical registry", () => {
  test("is closed and exposes the frozen field and object registries", () => {
    expect(SUITE_NAME).toBe("dotrelay-e2ee-v3-classical-webcrypto");
    expect(SUITE_VALUE).toBe(3);
    expect("v1" in OBJECT_REGISTRY).toBe(false);
    expect(FIELD_REGISTRY[49]?.name).toBe("reserved and forbidden");
    expect(OBJECT_REGISTRY[16]?.name).toBe("Revision");
    expect(OBJECT_REGISTRY[16]?.allowedFields).toContain(68);
    expect(OBJECT_REGISTRY[16]?.requiredFields).not.toContain(68);
  });

  test("round-trips a valid object and rejects v1, unknown fields, and bad lengths", () => {
    const object = userIdentity();
    const encoded = encodeProtocolObject(object);
    expect(parseProtocolObject(encoded)).toEqual(object);

    const wrongSuite = new Map<number, CborValue>(object);
    wrongSuite.set(0, 1);
    expect(() => encodeProtocolObject(wrongSuite)).toThrow(
      "unsupported_crypto_suite",
    );

    const unknown = new Map<number, CborValue>(object);
    unknown.set(86, 1);
    expect(() => encodeProtocolObject(unknown)).toThrow(
      "invalid_crypto_object",
    );

    const wrongIdentity = new Map<number, CborValue>(object);
    wrongIdentity.set(39, zeros(31));
    expect(() => encodeProtocolObject(wrongIdentity)).toThrow(
      "invalid_crypto_object",
    );

    const hostileFieldKey = new Map(object);
    hostileFieldKey.set("toString" as never, 1);
    expect(() => encodeProtocolObject(hostileFieldKey)).toThrow(
      "invalid_crypto_object",
    );
  });

  test("enforces canonical object and allocation ceilings", () => {
    expect(CBOR_LIMITS.maxDepth).toBe(12);
    expect(() =>
      parseProtocolObject(new Uint8Array(CBOR_LIMITS.maxObjectBytes + 1)),
    ).toThrow("payload_too_large");
  });
});

describe("runtime-neutral API contracts", () => {
  test("has stable v1 problems, strict JSON objects, capabilities, and idempotency", () => {
    expect(API_VERSION).toBe("v1");
    expect(PROBLEM_STATUS.invalid_crypto_object).toBe(400);
    expect(PROBLEM_STATUS.unsupported_crypto_runtime).toBe(422);
    expect(PROBLEM_STATUS.crypto_provider_unavailable).toBe(503);
    expect(createProblem("unsupported_crypto_suite").code).toBe(
      "unsupported_crypto_suite",
    );
    expect(createProblem("unsupported_crypto_runtime").status).toBe(422);
    expect(createProblem("crypto_provider_unavailable").status).toBe(503);
    expect(() => createProblem("not-a-code" as never)).toThrow(
      "invalid_request",
    );
    expect(() => createProblem("toString" as never)).toThrow("invalid_request");
    expect(parseJsonObject({ ok: true }, ["ok"])).toEqual({ ok: true });
    expect(() => parseJsonObject({ ok: true, extra: true }, ["ok"])).toThrow(
      "invalid_request",
    );
    expect(() =>
      parseJsonObject({ value: "x".repeat(CBOR_LIMITS.maxAdminBodyBytes) }, [
        "value",
      ]),
    ).toThrow("payload_too_large");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => parseJsonObject(cyclic, ["self"])).toThrow("invalid_request");
    let deeplyNested: unknown = { leaf: true };
    for (let depth = 0; depth <= CBOR_LIMITS.maxDepth; depth++)
      deeplyNested = [deeplyNested];
    expect(() => parseJsonObject({ deeplyNested }, ["deeplyNested"])).toThrow(
      "invalid_request",
    );
    expect(
      OPENAPI_DOCUMENT.components.schemas.Problem.properties,
    ).toMatchObject({
      retryAfterSeconds: { type: "integer", minimum: 0 },
      headId: { type: "string" },
      headHash: { type: "string" },
    });
    expect(createCapabilitiesDocument().suite).toEqual({
      name: SUITE_NAME,
      value: SUITE_VALUE,
    });
    expect(createCapabilitiesDocument().limits.stagingTtlSeconds).toBe(86_400);
    expect(parseCapabilitiesDocument(createCapabilitiesDocument())).toEqual(
      createCapabilitiesDocument(),
    );
    expect(() =>
      parseCapabilitiesDocument({
        ...createCapabilitiesDocument(),
        extra: true,
      }),
    ).toThrow("invalid_request");
    expect(
      parseProblem({
        ...createProblem("unsupported_crypto_suite"),
        instance: "/api/v1/capabilities",
      }),
    ).toMatchObject({
      code: "unsupported_crypto_suite",
      instance: "/api/v1/capabilities",
      status: 422,
    });
    expect(() =>
      parseProblem({ ...createProblem("invalid_request"), status: 422 }),
    ).toThrow("invalid_request");
    expect(validateIdempotencyKey("00000000-0000-4000-8000-000000000000")).toBe(
      true,
    );
    expect(validateIdempotencyKey("00000000-0000-0000-8000-000000000000")).toBe(
      true,
    );
    expect(validateIdempotencyKey("not-an-idempotency-key")).toBe(false);
  });
});
