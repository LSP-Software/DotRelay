import { describe, expect, test } from "bun:test";
import {
  CBOR_LIMITS,
  type CborValue,
  ContractError,
  canonicalDecode,
  canonicalEncode,
  ENUM_REGISTRIES,
  encodeProtocolObject,
  FIXED_LENGTHS,
  isSignedField,
  parseProtocolObject,
  unsignedBodyBytes,
  validateManifestCeilings,
} from "@dotrelay/contracts";
import { NEGATIVE_VECTOR_CASES, VECTOR_CASES } from "./vector-fixtures";

const containsText = (value: CborValue): boolean => {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.some(containsText);
  if (value instanceof Map) return [...value.values()].some(containsText);
  return false;
};

const bytesFromHex = (value: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new Error("invalid vector hex");
  return Uint8Array.from(
    value.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
};

const sha384Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-384",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const frozenVectors = async (): Promise<
  Array<{ canonicalHex: string; unsignedBodyHex: string }>
> => {
  const objects = await Bun.file("test-vectors/e2ee/v2/objects.json").json();
  const conditional = await Bun.file(
    "test-vectors/e2ee/v2/conditional.json",
  ).json();
  return [...objects.vectors, ...conditional.vectors];
};

const frozenNegativeVectors = async (): Promise<
  Array<{ id: string; hex: string; error: string }>
> => {
  const negative = await Bun.file("test-vectors/e2ee/v2/negative.json").json();
  return negative.cases;
};

describe("immutable dotrelay-e2ee-v2 vectors", () => {
  test("checks deterministic-CBOR primitive and domain fixtures", async () => {
    const primitives = await Bun.file(
      "test-vectors/e2ee/v2/primitives.json",
    ).json();
    const values: Record<string, CborValue> = {
      "uint-0": 0,
      "uint-23": 23,
      "uint-24": 24,
      "uint-255": 255,
      "uint-256": 256,
      "uint-2^32": 4294967296,
      "empty-map": new Map(),
      "integer-keyed-map": new Map<number, CborValue>([
        [0, 2],
        [1, "one"],
      ]),
      "byte-string": Uint8Array.of(0, 1, 255),
      "utf8-text": "é",
      array: [1, 2],
    };
    for (const vector of primitives.cbor as Array<{
      id: string;
      canonicalHex: string;
    }>) {
      const value = values[vector.id];
      if (value === undefined)
        throw new Error(`missing primitive: ${vector.id}`);
      expect(Array.from(canonicalEncode(value))).toEqual(
        Array.from(bytesFromHex(vector.canonicalHex)),
      );
    }
    for (const vector of primitives.domainSeparators as Array<{
      utf8Hex: string;
      sha384Hex: string;
    }>) {
      const bytes = bytesFromHex(vector.utf8Hex);
      expect(
        Array.from(new TextEncoder().encode(new TextDecoder().decode(bytes))),
      ).toEqual(Array.from(bytes));
      expect(await sha384Hex(bytes)).toBe(vector.sha384Hex);
    }
    expect(primitives.fixedLengths).toEqual(FIXED_LENGTHS);
  });

  test("checks in the positive, negative, and browser/Bun corpus manifests", async () => {
    const positive = await Bun.file(
      "test-vectors/e2ee/v2/positive.json",
    ).json();
    const negative = await Bun.file(
      "test-vectors/e2ee/v2/negative.json",
    ).json();
    const browserBun = await Bun.file(
      "test-vectors/e2ee/v2/browser-bun.json",
    ).json();
    const objects = await Bun.file("test-vectors/e2ee/v2/objects.json").json();
    const conditional = await Bun.file(
      "test-vectors/e2ee/v2/conditional.json",
    ).json();
    expect(positive).toMatchObject({
      suite: "dotrelay-e2ee-v2",
      suiteValue: 2,
      immutable: true,
    });
    expect(positive.objects).toHaveLength(19);
    expect(objects.vectors).toHaveLength(19);
    expect(conditional.vectors).toHaveLength(28);
    expect(objects.vectors.map((vector: { id: string }) => vector.id)).toEqual(
      positive.objects.map((vector: { id: string }) => vector.id),
    );
    expect(
      VECTOR_CASES.filter((vector) => vector.id.startsWith("object-")).map(
        (vector) => ({
          id: vector.id,
          kind: vector.kind,
          canonicalHex: Array.from(
            encodeProtocolObject(vector.object),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join(""),
        }),
      ),
    ).toEqual(
      objects.vectors.map(
        (vector: { id: string; kind: number; canonicalHex: string }) => ({
          id: vector.id,
          kind: vector.kind,
          canonicalHex: vector.canonicalHex,
        }),
      ),
    );
    expect(
      VECTOR_CASES.filter((vector) => !vector.id.startsWith("object-")).map(
        (vector) => ({
          id: vector.id,
          kind: vector.kind,
          canonicalHex: Array.from(
            encodeProtocolObject(vector.object),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join(""),
        }),
      ),
    ).toEqual(
      conditional.vectors.map(
        (vector: { id: string; kind: number; canonicalHex: string }) => ({
          id: vector.id,
          kind: vector.kind,
          canonicalHex: vector.canonicalHex,
        }),
      ),
    );
    expect(negative).toMatchObject({
      suite: "dotrelay-e2ee-v2",
      immutable: true,
    });
    expect(negative.cases.length).toBeGreaterThanOrEqual(14);
    expect(
      [...negative.cases.map((vector: { id: string }) => vector.id)].sort(),
    ).toEqual([...NEGATIVE_VECTOR_CASES.map((vector) => vector.id)].sort());
    expect(
      negative.cases
        .map((vector: { hex: string; error: string }) => ({
          hex: vector.hex,
          error: vector.error,
        }))
        .sort((left: { hex: string }, right: { hex: string }) =>
          left.hex.localeCompare(right.hex),
        ),
    ).toEqual(
      NEGATIVE_VECTOR_CASES.map((vector) => ({
        hex: Array.from(vector.bytes, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
        error: vector.error,
      })).sort((left, right) => left.hex.localeCompare(right.hex)),
    );
    expect(browserBun).toMatchObject({
      suite: "dotrelay-e2ee-v2",
      immutable: true,
    });
    for (const fixture of browserBun.fixtures as Array<{
      browserToBun: boolean;
      bunToBrowser: boolean;
      hex: string;
    }>) {
      const bytes = bytesFromHex(fixture.hex);
      expect(canonicalEncode(canonicalDecode(bytes))).toEqual(bytes);
      expect(fixture.browserToBun && fixture.bunToBrowser).toBe(true);
    }
    for (const [name, values] of Object.entries(positive.enumCoverage)) {
      const registryValues = Object.keys(
        ENUM_REGISTRIES[name as keyof typeof ENUM_REGISTRIES],
      ).map(Number);
      expect(values).toEqual(expect.arrayContaining(registryValues));
    }
  });

  test("covers every closed object kind, enum registry, and canonical round trip", async () => {
    const kinds = new Set(VECTOR_CASES.map((vector) => vector.kind));
    expect(kinds).toEqual(
      new Set(Array.from({ length: 19 }, (_, index) => index + 1)),
    );
    for (const vector of await frozenVectors()) {
      const bytes = bytesFromHex(vector.canonicalHex);
      const object = parseProtocolObject(bytes);
      expect(canonicalEncode(object)).toEqual(bytes);
      expect(unsignedBodyBytes(object)).toEqual(
        bytesFromHex(vector.unsignedBodyHex),
      );
      expect(containsText(object)).toBe(false);
    }
    for (const vector of VECTOR_CASES) {
      const encoded = encodeProtocolObject(vector.object);
      expect(parseProtocolObject(encoded)).toEqual(vector.object);
      expect(containsText(canonicalDecode(encoded))).toBe(false);
    }
  });

  test("rejects every frozen malformed case with only coarse errors", async () => {
    for (const vector of await frozenNegativeVectors()) {
      expect(() => parseProtocolObject(bytesFromHex(vector.hex))).toThrow(
        vector.error,
      );
    }
  });

  test("keeps protocol ceilings explicit and excludes plaintext", () => {
    expect(CBOR_LIMITS.maxDepth).toBe(12);
    expect(CBOR_LIMITS.maxGrantPlaintextBytes).toBe(4096);
    expect(() =>
      encodeProtocolObject(
        new Map<number, CborValue>([
          [0, 2],
          [1, 11],
          [2, 1],
          [8, "plaintext"],
        ]),
      ),
    ).toThrow("invalid_crypto_object");
    expect(() =>
      parseProtocolObject(new Uint8Array(CBOR_LIMITS.maxObjectBytes + 1)),
    ).toThrow("payload_too_large");
    expect(() =>
      canonicalEncode(
        Array.from({ length: CBOR_LIMITS.maxCollectionItems + 1 }, () => 1),
      ),
    ).toThrow("payload_too_large");
    expect(() =>
      validateManifestCeilings({
        variables: CBOR_LIMITS.maxManifestVariables + 1,
        laneCommitments: 0,
      }),
    ).toThrow("payload_too_large");
    expect(() =>
      validateManifestCeilings({
        variables: 0,
        laneCommitments: CBOR_LIMITS.maxManifestLaneCommitments + 1,
      }),
    ).toThrow("payload_too_large");
    const oversizedGrant = new Map(
      VECTOR_CASES.find((vector) => vector.id === "object-7")?.object ?? [],
    );
    oversizedGrant.set(71, (1n << 64n) - 1n);
    oversizedGrant.set(
      3,
      canonicalEncode(
        new Map(
          [...oversizedGrant.entries()].filter(
            ([field]) => !isSignedField(field),
          ),
        ),
      ),
    );
    expect(() => encodeProtocolObject(oversizedGrant)).toThrow(
      "payload_too_large",
    );
  });

  test("does not expose component-specific failures", async () => {
    for (const vector of await frozenNegativeVectors()) {
      try {
        parseProtocolObject(bytesFromHex(vector.hex));
        throw new Error("vector unexpectedly accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(ContractError);
        expect((error as ContractError).code).toMatch(
          /^(invalid_crypto_object|unsupported_crypto_suite)$/,
        );
      }
    }
  });
});
