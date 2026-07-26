import { describe, expect, test } from "bun:test";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  sign,
  verify,
} from "node:crypto";
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

const hexFromBytes = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha384Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-384",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const canonicalVectorFiles = [
  "browser-bun.json",
  "conditional.json",
  "negative.json",
  "objects.json",
  "positive.json",
  "primitives.json",
  "rfc-primitives.json",
] as const;

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
  test("verifies the independently committed corpus manifest", async () => {
    const manifest = await Bun.file(
      "test-vectors/e2ee/v2/manifest.json",
    ).json();
    expect(manifest).toMatchObject({
      suite: "dotrelay-e2ee-v2",
      suiteValue: 2,
      immutable: true,
      hash: "sha-384",
    });
    expect(manifest.files.map((entry: { path: string }) => entry.path)).toEqual(
      canonicalVectorFiles,
    );
    for (const entry of manifest.files as Array<{
      path: string;
      sha384: string;
    }>) {
      expect(
        await sha384Hex(
          new Uint8Array(
            await Bun.file(`test-vectors/e2ee/v2/${entry.path}`).arrayBuffer(),
          ),
        ),
      ).toBe(entry.sha384);
    }
  });

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

  test("pins RFC primitives, exact intermediates, and ACVP operations", async () => {
    const primitives = await Bun.file(
      "test-vectors/e2ee/v2/rfc-primitives.json",
    ).json();
    expect(primitives.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rfc-5869-a.1",
          intermediates: {
            prkHex:
              "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5",
          },
          output: {
            okmHex:
              "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
          },
        }),
        expect.objectContaining({
          id: "rfc-7748-5.2-x25519-1",
          output: {
            uCoordinateHex:
              "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
          },
        }),
        expect.objectContaining({
          id: "rfc-8032-7.1-ed25519-1",
          intermediates: {
            publicKeyHex:
              "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
          },
        }),
      ]),
    );
    expect(
      primitives.acvpReferences.map(
        (reference: { id: string }) => reference.id,
      ),
    ).toEqual([
      "ml-kem-keygen-fips203",
      "ml-kem-encap-decap-fips203",
      "ml-dsa-keygen-fips204",
      "ml-dsa-sign-fips204",
      "ml-dsa-verify-fips204",
    ]);

    const sourceById = new Map(
      primitives.sources.map((source: { id: string }) => [source.id, source]),
    );
    const hkdf = sourceById.get("rfc-5869-a.1") as {
      input: {
        ikmHex: string;
        saltHex: string;
        infoHex: string;
        length: number;
      };
      intermediates: { prkHex: string };
      output: { okmHex: string };
    };
    const prk = createHmac("sha256", bytesFromHex(hkdf.input.saltHex))
      .update(bytesFromHex(hkdf.input.ikmHex))
      .digest();
    expect(hexFromBytes(new Uint8Array(prk))).toBe(hkdf.intermediates.prkHex);
    expect(
      hexFromBytes(
        new Uint8Array(
          hkdfSync(
            "sha256",
            bytesFromHex(hkdf.input.ikmHex),
            bytesFromHex(hkdf.input.saltHex),
            bytesFromHex(hkdf.input.infoHex),
            hkdf.input.length,
          ),
        ),
      ),
    ).toBe(hkdf.output.okmHex);

    const x25519 = sourceById.get("rfc-7748-5.2-x25519-1") as {
      input: { scalarHex: string; uCoordinateHex: string };
      output: { uCoordinateHex: string };
    };
    const x25519Private = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b656e04220420", "hex"),
        Buffer.from(x25519.input.scalarHex, "hex"),
      ]),
      format: "der",
      type: "pkcs8",
    });
    const x25519Public = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b656e032100", "hex"),
        Buffer.from(x25519.input.uCoordinateHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    expect(
      hexFromBytes(
        new Uint8Array(
          diffieHellman({ privateKey: x25519Private, publicKey: x25519Public }),
        ),
      ),
    ).toBe(x25519.output.uCoordinateHex);

    const ed25519 = sourceById.get("rfc-8032-7.1-ed25519-1") as {
      input: { seedHex: string; messageHex: string };
      intermediates: { publicKeyHex: string };
      output: { signatureHex: string };
    };
    const ed25519Private = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.from(ed25519.input.seedHex, "hex"),
      ]),
      format: "der",
      type: "pkcs8",
    });
    const ed25519Public = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(ed25519.intermediates.publicKeyHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    const message = Buffer.from(ed25519.input.messageHex, "hex");
    const signature = sign(null, message, ed25519Private);
    expect(hexFromBytes(new Uint8Array(signature))).toBe(
      ed25519.output.signatureHex,
    );
    expect(verify(null, message, ed25519Public, signature)).toBe(true);

    const sha384 = sourceById.get("fips-180-4-sha-384-abc") as {
      input: { messageHex: string };
      output: { digestHex: string };
    };
    expect(
      hexFromBytes(
        new Uint8Array(
          createHash("sha384")
            .update(bytesFromHex(sha384.input.messageHex))
            .digest(),
        ),
      ),
    ).toBe(sha384.output.digestHex);
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
      hex: string;
    }>) {
      const bytes = bytesFromHex(fixture.hex);
      expect(canonicalEncode(canonicalDecode(bytes))).toEqual(bytes);
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
