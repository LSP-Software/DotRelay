import { describe, expect, test } from "bun:test";
import {
  DOTRELAY_PROTOCOL_FORMAT_VERSION,
  DOTRELAY_V3_SUITE,
  validateCanonicalCbor,
  validateLaneProjection,
  validateProtocolProjection,
  validateSha384Digest,
} from "./validation";

const bytes = (length: number) => new Uint8Array(length);

describe("persistence validation boundary", () => {
  test("accepts the current suite and verifies its SHA-384 digest", async () => {
    const canonicalBytes = Uint8Array.of(0xa0);
    const digest = Uint8Array.from(
      Buffer.from(
        "79cbe0a2e6db246b4f2a60e464eae842cf4e3c8dba2928c6edda2c205ca979d8ae3cb9fa1cc52c29dc727b841f74334c",
        "hex",
      ),
    );

    expect(() =>
      validateProtocolProjection({
        suite: DOTRELAY_V3_SUITE,
        formatVersion: DOTRELAY_PROTOCOL_FORMAT_VERSION,
        kind: 13,
        canonicalBytes,
        digest,
      }),
    ).not.toThrow();
    expect(await validateSha384Digest(canonicalBytes, digest)).toEqual(digest);
  });

  test("rejects a digest that does not match its bytes", async () => {
    await expect(validateSha384Digest(bytes(4), bytes(48))).rejects.toThrow(
      "does not match",
    );
  });

  test("rejects a superseded suite before persistence", () => {
    expect(() =>
      validateProtocolProjection({
        suite: "dotrelay-e2ee-v2-classical-webcrypto",
        formatVersion: DOTRELAY_PROTOCOL_FORMAT_VERSION,
        kind: 13,
        canonicalBytes: Uint8Array.of(0xa0),
        digest: bytes(48),
      }),
    ).toThrow("protocol object suite is not supported");
  });

  test("rejects non-canonical and non-map protocol bytes", () => {
    expect(() => validateCanonicalCbor(Uint8Array.of(0x18, 0x17))).toThrow(
      "non-minimal",
    );
    expect(() => validateCanonicalCbor(Uint8Array.of(0x01))).toThrow(
      "must be a CBOR map",
    );
  });

  test("enforces lane ownership projection without seeing plaintext", () => {
    expect(() =>
      validateLaneProjection({
        scope: "USER_DEFINED_VALUE",
        projectEpoch: 1n,
        plaintextLength: 12,
        ciphertextLength: 28,
        ciphertextHash: bytes(48),
      }),
    ).toThrow("owner User");

    expect(() =>
      validateLaneProjection({
        scope: "SHARED_VALUE",
        originalProviderUserId: "provider",
        projectEpoch: 1n,
        plaintextLength: 12,
        ciphertextLength: 28,
        ciphertextHash: bytes(48),
      }),
    ).not.toThrow();

    expect(() =>
      validateLaneProjection({
        scope: "ENVIRONMENT_DEFINITION",
        ownerUserId: "owner",
        projectEpoch: 1n,
        plaintextLength: 12,
        ciphertextLength: 28,
        ciphertextHash: bytes(48),
      }),
    ).toThrow("definition lanes cannot carry a User owner or provider");

    expect(() =>
      validateLaneProjection({
        scope: "VARIABLE_DEFINITION",
        originalProviderUserId: "provider",
        projectEpoch: 1n,
        plaintextLength: 12,
        ciphertextLength: 28,
        ciphertextHash: bytes(48),
      }),
    ).toThrow("definition lanes cannot carry a User owner or provider");

    expect(() =>
      validateLaneProjection({
        scope: "SHARED_VALUE",
        originalProviderUserId: "provider",
        ownerUserId: "owner",
        projectEpoch: 1n,
        plaintextLength: 12,
        ciphertextLength: 28,
        ciphertextHash: bytes(48),
      }),
    ).toThrow("Shared Value lanes require only an original provider");

    expect(() =>
      validateLaneProjection({
        scope: "USER_DEFINED_VALUE",
        ownerUserId: "owner",
        originalProviderUserId: "provider",
        projectEpoch: 1n,
        plaintextLength: 12,
        ciphertextLength: 28,
        ciphertextHash: bytes(48),
      }),
    ).toThrow("User-defined Value lanes require only an owner User");
  });
});
