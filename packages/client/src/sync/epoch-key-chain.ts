import {
  type CborValue,
  canonicalEncode,
  deriveAesKeyWithInfo,
  encodeProtocolObject,
  type ProtocolObject,
  PROJECT_EPOCH_KEY_LINK_KDF_INFO,
  parseProtocolObject,
  protocolObjectFromFields,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import { isSignedByTrustedKey } from "../trust/verify";
import type { SharedValueKeyRing } from "./publication";

// A Project Epoch Key Link seals the epoch-n key under the epoch-(n+1) key
// (ADR 0014). Walking the links backwards from the current key rebuilds the
// whole Project key ring without per-Member fan-out.
export const PROJECT_EPOCH_KEY_LINK_KIND = 23;

// Fields left out of the associated data: the signature envelope and the
// values that only exist after encryption.
const AAD_EXCLUDED = new Set([3, 4, 47, 48, 72]);

export type ProjectEpochKeyLinkContext = Readonly<{
  readonly serverProfileId: string;
  readonly teamId: string;
  readonly projectId: string;
}>;

export type ProjectEpochKeyLink = Readonly<{
  readonly objectId: string;
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
  readonly fromEpoch: number;
  readonly toEpoch: number;
}>;

export class ProjectEpochKeyLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectEpochKeyLinkError";
  }
}

const toBuffer = (input: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const associatedData = (object: ProtocolObject): Uint8Array =>
  canonicalEncode(
    new Map(
      [...object.entries()].filter(([field]) => !AAD_EXCLUDED.has(field)),
    ),
  );

const linkKey = (toKey: Uint8Array, salt: Uint8Array): Promise<CryptoKey> =>
  deriveAesKeyWithInfo(toKey, salt, PROJECT_EPOCH_KEY_LINK_KDF_INFO);

const requireEpochKey = (key: Uint8Array, label: string): void => {
  if (!(key instanceof Uint8Array) || key.length !== 32)
    throw new TypeError(`${label} must be 32 bytes`);
};

export const createProjectEpochKeyLink = async (
  input: ProjectEpochKeyLinkContext &
    Readonly<{
      readonly fromEpoch: number;
      readonly fromKey: Uint8Array;
      readonly toKey: Uint8Array;
      readonly signingDeviceId: string;
      readonly signingPrivateKey: CryptoKey;
      readonly createdAtMs?: number;
    }>,
): Promise<ProjectEpochKeyLink> => {
  if (!Number.isSafeInteger(input.fromEpoch) || input.fromEpoch < 1)
    throw new TypeError("project epoch key link from-epoch is invalid");
  requireEpochKey(input.fromKey, "from-epoch key");
  requireEpochKey(input.toKey, "to-epoch key");
  const toEpoch = input.fromEpoch + 1;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.serverProfileId)],
    [11, uuidToBytes(input.teamId)],
    [13, uuidToBytes(input.projectId)],
    [17, uuidToBytes(crypto.randomUUID())],
    [23, uuidToBytes(input.signingDeviceId)],
    [32, input.createdAtMs ?? Date.now()],
    [44, salt],
    [46, iv],
    [62, input.fromEpoch],
    [63, toEpoch],
    [71, 32],
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toBuffer(iv),
        additionalData: toBuffer(
          associatedData(
            protocolObjectFromFields(PROJECT_EPOCH_KEY_LINK_KIND, fields),
          ),
        ),
        tagLength: 128,
      },
      await linkKey(input.toKey, salt),
      toBuffer(input.fromKey),
    ),
  );
  fields.set(47, ciphertext);
  fields.set(48, await sha384(ciphertext));
  fields.set(72, ciphertext.length);
  const unsigned = protocolObjectFromFields(
    PROJECT_EPOCH_KEY_LINK_KIND,
    fields,
  );
  const envelope = new Map<number, CborValue>([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  envelope.set(
    4,
    await signProtocolObject(
      protocolObjectFromFields(PROJECT_EPOCH_KEY_LINK_KIND, envelope),
      input.signingPrivateKey,
    ),
  );
  const canonicalBytes = encodeProtocolObject(
    protocolObjectFromFields(PROJECT_EPOCH_KEY_LINK_KIND, envelope),
  );
  return Object.freeze({
    objectId: crypto.randomUUID(),
    canonicalBytes,
    digest: await sha384(canonicalBytes),
    fromEpoch: input.fromEpoch,
    toEpoch,
  });
};

const epochField = (object: ProtocolObject, field: number): number => {
  const value = object.get(field);
  const epoch = typeof value === "bigint" ? Number(value) : value;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1)
    throw new ProjectEpochKeyLinkError("link epoch is invalid");
  return epoch;
};

const bytesField = (object: ProtocolObject, field: number): Uint8Array => {
  const value = object.get(field);
  if (!(value instanceof Uint8Array))
    throw new ProjectEpochKeyLinkError(`link field ${field} is missing`);
  return value;
};

// Parses a link and reads its epochs without trusting it. Returns null for
// bytes that are not a well-formed link, so a garbage entry cannot claim an
// epoch.
export const readProjectEpochKeyLinkEpochs = (
  bytes: Uint8Array,
): Readonly<{ fromEpoch: number; toEpoch: number }> | null => {
  try {
    const object = parseProtocolObject(bytes);
    if (object.get(1) !== PROJECT_EPOCH_KEY_LINK_KIND) return null;
    return {
      fromEpoch: epochField(object, 62),
      toEpoch: epochField(object, 63),
    };
  } catch {
    return null;
  }
};

// Verifies one link and opens the from-epoch key. Every check fails closed
// with the same error type: binding, contiguity, signature, digest, then the
// AES-GCM tag under the to-epoch key.
export const openProjectEpochKeyLink = async (
  bytes: Uint8Array,
  input: ProjectEpochKeyLinkContext &
    Readonly<{
      readonly toEpoch: number;
      readonly toKey: Uint8Array;
      readonly trustedSigningKeys: readonly Uint8Array[];
    }>,
): Promise<Uint8Array> => {
  let object: ProtocolObject;
  try {
    object = parseProtocolObject(bytes);
  } catch {
    throw new ProjectEpochKeyLinkError("link is malformed");
  }
  if (object.get(1) !== PROJECT_EPOCH_KEY_LINK_KIND)
    throw new ProjectEpochKeyLinkError(
      "object is not a project epoch key link",
    );
  for (const [field, expected] of [
    [8, input.serverProfileId],
    [11, input.teamId],
    [13, input.projectId],
  ] as const)
    if (!sameBytes(bytesField(object, field), uuidToBytes(expected)))
      throw new ProjectEpochKeyLinkError("link is bound to another project");
  const fromEpoch = epochField(object, 62);
  const toEpoch = epochField(object, 63);
  if (toEpoch !== input.toEpoch || fromEpoch !== toEpoch - 1)
    throw new ProjectEpochKeyLinkError("link epochs are not contiguous");
  if (!(await isSignedByTrustedKey(object, input.trustedSigningKeys)))
    throw new ProjectEpochKeyLinkError("link signature is not trusted");
  const ciphertext = bytesField(object, 47);
  if (!sameBytes(await sha384(ciphertext), bytesField(object, 48)))
    throw new ProjectEpochKeyLinkError("link ciphertext digest mismatch");
  requireEpochKey(input.toKey, "to-epoch key");
  let fromKey: Uint8Array;
  try {
    fromKey = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toBuffer(bytesField(object, 46)),
          additionalData: toBuffer(associatedData(object)),
          tagLength: 128,
        },
        await linkKey(input.toKey, bytesField(object, 44)),
        toBuffer(ciphertext),
      ),
    );
  } catch {
    throw new ProjectEpochKeyLinkError("link does not open");
  }
  if (fromKey.length !== 32)
    throw new ProjectEpochKeyLinkError("link key length is invalid");
  return fromKey;
};

export type ProjectEpochKeyChainBreak = Readonly<{
  /** The to-epoch whose link was absent, duplicated, or failed verification. */
  readonly toEpoch: number;
  readonly reason: "missing" | "duplicate" | "invalid";
}>;

export type ProjectEpochKeyChain = Readonly<{
  /** Every epoch key recovered, including the current one. */
  readonly ring: SharedValueKeyRing;
  /** Null when the ring reaches epoch 1. */
  readonly break: ProjectEpochKeyChainBreak | null;
}>;

// Walks the links from the current epoch down to epoch 1. The walk stops at
// the first missing, duplicated or unverifiable link; older epochs then stay
// out of the ring and their lanes remain unreadable.
export const openProjectEpochKeyChain = async (
  input: ProjectEpochKeyLinkContext &
    Readonly<{
      readonly links: readonly Uint8Array[];
      readonly currentEpoch: number;
      readonly currentKey: Uint8Array;
      readonly trustedSigningKeys: readonly Uint8Array[];
    }>,
): Promise<ProjectEpochKeyChain> => {
  if (!Number.isSafeInteger(input.currentEpoch) || input.currentEpoch < 1)
    throw new TypeError("current project epoch is invalid");
  requireEpochKey(input.currentKey, "current epoch key");
  const byToEpoch = new Map<number, Uint8Array[]>();
  for (const bytes of input.links) {
    const epochs = readProjectEpochKeyLinkEpochs(bytes);
    if (!epochs) continue;
    byToEpoch.set(epochs.toEpoch, [
      ...(byToEpoch.get(epochs.toEpoch) ?? []),
      bytes,
    ]);
  }
  const ring = new Map<number, Uint8Array>([
    [input.currentEpoch, new Uint8Array(input.currentKey)],
  ]);
  for (let toEpoch = input.currentEpoch; toEpoch > 1; toEpoch -= 1) {
    const candidates = byToEpoch.get(toEpoch) ?? [];
    if (candidates.length === 0)
      return { ring, break: { toEpoch, reason: "missing" } };
    if (candidates.length > 1)
      return { ring, break: { toEpoch, reason: "duplicate" } };
    try {
      ring.set(
        toEpoch - 1,
        await openProjectEpochKeyLink(candidates[0]!, {
          serverProfileId: input.serverProfileId,
          teamId: input.teamId,
          projectId: input.projectId,
          toEpoch,
          toKey: ring.get(toEpoch)!,
          trustedSigningKeys: input.trustedSigningKeys,
        }),
      );
    } catch {
      return { ring, break: { toEpoch, reason: "invalid" } };
    }
  }
  return { ring, break: null };
};

// The to-epochs (2..currentEpoch) with no parseable link at all. These are the
// only gaps a client may backfill: a to-epoch that already has a link, even an
// unverifiable one, is the service's to arbitrate.
export const missingProjectEpochKeyLinks = (
  links: readonly Uint8Array[],
  currentEpoch: number,
): number[] => {
  const present = new Set(
    links
      .map(readProjectEpochKeyLinkEpochs)
      .filter((epochs) => epochs !== null)
      .map((epochs) => epochs.toEpoch),
  );
  const missing: number[] = [];
  for (let toEpoch = 2; toEpoch <= currentEpoch; toEpoch += 1)
    if (!present.has(toEpoch)) missing.push(toEpoch);
  return missing;
};

// Creates the links a client can backfill from keys it already holds, for
// example past-epoch Account Key Envelopes. Each link needs both its from-
// and to-epoch keys; a gap with either key unknown is left for another
// client.
export const createProjectEpochKeyLinkBackfill = async (
  input: ProjectEpochKeyLinkContext &
    Readonly<{
      readonly links: readonly Uint8Array[];
      readonly currentEpoch: number;
      readonly knownKeys: SharedValueKeyRing;
      readonly signingDeviceId: string;
      readonly signingPrivateKey: CryptoKey;
    }>,
): Promise<ProjectEpochKeyLink[]> => {
  const created: ProjectEpochKeyLink[] = [];
  for (const toEpoch of missingProjectEpochKeyLinks(
    input.links,
    input.currentEpoch,
  )) {
    const fromKey = input.knownKeys.get(toEpoch - 1);
    const toKey = input.knownKeys.get(toEpoch);
    if (!fromKey || !toKey) continue;
    created.push(
      await createProjectEpochKeyLink({
        serverProfileId: input.serverProfileId,
        teamId: input.teamId,
        projectId: input.projectId,
        fromEpoch: toEpoch - 1,
        fromKey,
        toKey,
        signingDeviceId: input.signingDeviceId,
        signingPrivateKey: input.signingPrivateKey,
      }),
    );
  }
  return created;
};
