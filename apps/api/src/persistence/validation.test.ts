import { describe, expect, test } from "bun:test";
import {
  DOTRELAY_PROTOCOL_FORMAT_VERSION,
  DOTRELAY_V3_SUITE,
  PersistenceValidationError,
  validateLaneProjection,
  validateProtocolProjection,
  validateSha384Digest,
} from "./validation";

const bytes = (length: number) => new Uint8Array(length);

describe("persistence validation boundary", () => {
  test("accepts the current suite and verifies its SHA-384 digest", async () => {
    const canonicalBytes = bytes(4);
    const digest = Uint8Array.from(
      Buffer.from(
        "394341b7182cd227c5c6b07ef8000cdfd86136c4292b8e576573ad7ed9ae41019f5818b4b971c9effc60e1ad9f1289f0",
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
        suite: "dotrelay-e2ee-v2",
        formatVersion: 2,
        kind: 13,
        canonicalBytes: bytes(4),
        digest: bytes(48),
      }),
    ).toThrow(PersistenceValidationError);
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
  });
});
