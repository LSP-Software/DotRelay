import { type CborValue, canonicalEncode } from "./cbor";
import { contractError } from "./errors";

// A ciphertext lane (kind 13) names the layout of its AES-GCM associated
// data in field 50.
//
// - Format 1 binds only the Variable, Revision and lane scope. Lanes written
//   before ADR 0022 use it and stay readable.
// - Format 2 also binds the Server Profile, Team, Project, Environment,
//   owner or original provider, Project epoch and the format itself, so a
//   ciphertext cannot be moved into a lane for another context: a
//   User-defined Value sealed for one Team opens nowhere else.
export const LANE_FORMAT_LEGACY = 1;
export const LANE_FORMAT_CONTEXT_BOUND = 2;
export const LANE_FORMATS: readonly number[] = Object.freeze([
  LANE_FORMAT_LEGACY,
  LANE_FORMAT_CONTEXT_BOUND,
]);

const LEGACY_FIELDS = [15, 16, 36] as const;
// Every identity field a format-2 lane binds, in ascending order.
const CONTEXT_FIELDS = [8, 11, 13, 14, 15, 16, 26, 27, 30, 36, 50] as const;
// The ones a format-2 lane must carry; 26 and 27 depend on the scope.
const CONTEXT_REQUIRED = [8, 11, 13, 14, 15, 16, 30, 36, 50] as const;

const format = (lane: ReadonlyMap<number, CborValue>): number | undefined => {
  const value = lane.get(50);
  if (typeof value === "number") return value;
  if (typeof value === "bigint" && value <= 2n) return Number(value);
  return undefined;
};

/**
 * The AES-GCM associated data of a ciphertext lane: the canonical CBOR map
 * of the identity fields its format binds, read from the lane itself. The
 * sealer passes the lane's fields before the ciphertext exists; the opener
 * passes the parsed lane. A lane of an unknown format, or one missing a
 * bound field, is rejected before any decryption.
 */
export const laneAssociatedData = (
  lane: ReadonlyMap<number, CborValue>,
): Uint8Array => {
  const version = format(lane);
  if (version === LANE_FORMAT_LEGACY) {
    if (LEGACY_FIELDS.some((field) => !lane.has(field)))
      contractError("invalid_crypto_object");
    return canonicalEncode(
      new Map<number, CborValue>(
        LEGACY_FIELDS.map((field) => [field, lane.get(field) as CborValue]),
      ),
    );
  }
  if (version === LANE_FORMAT_CONTEXT_BOUND) {
    if (CONTEXT_REQUIRED.some((field) => !lane.has(field)))
      contractError("invalid_crypto_object");
    return canonicalEncode(
      new Map<number, CborValue>(
        CONTEXT_FIELDS.filter((field) => lane.has(field)).map((field) => [
          field,
          lane.get(field) as CborValue,
        ]),
      ),
    );
  }
  return contractError("invalid_crypto_object");
};
