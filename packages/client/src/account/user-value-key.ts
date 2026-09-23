import { KEY_ENVELOPE_TYPE } from "./constants";
import { openAccountKeyEnvelope, parseAccountKeyEnvelope } from "./index";
import type {
  AccountKeyTrustedKeys,
  AccountKeyVerificationContext,
} from "./verification";

// One content key per owner until a future rotation defines a new generation.
// Field 31 on the envelope is this generation, not a protocol-kind change.
export const USER_VALUE_KEY_GENERATION = 1;

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
};

const signingKeyHex = (value: string): string | null => {
  const hex = value.trim().toLowerCase();
  // Device signing keys are compared as the hex the trust history already
  // stores. Raw 32-byte keys and the SPKI form used on the boundary are both
  // accepted; anything that is not that hex is not a key.
  return /^(?:[0-9a-f]{2}){32,80}$/u.test(hex) ? hex : null;
};

// A creator public key that arrived beside an account-key object is not a
// trust anchor. It is used only when that exact key is already in the Device
// trust history the client held before this response.
export const deviceHistorySigningKeys = (
  boundary: Readonly<{
    readonly signingTrustDevices?: readonly Readonly<{
      readonly signingPublicKey: string;
    }>[];
    readonly signingTrustKeys?: readonly string[];
    readonly device?: Readonly<{ readonly signingPublicKey?: string }>;
    readonly peerDevices?: readonly Readonly<{
      readonly signingPublicKey: string;
    }>[];
  }>,
): readonly string[] =>
  Object.freeze([
    ...(boundary.signingTrustDevices ?? []).map(
      (device) => device.signingPublicKey,
    ),
    ...(boundary.signingTrustKeys ?? []),
    ...(boundary.device?.signingPublicKey
      ? [boundary.device.signingPublicKey]
      : []),
    ...(boundary.peerDevices ?? [])
      .map((peer) => peer.signingPublicKey)
      .filter((key) => key.length > 0),
  ]);

export const authenticatedCreatorKeys = (
  claimedKeys: readonly string[],
  deviceHistoryKeys: readonly string[],
): readonly string[] => {
  const history = new Set<string>();
  for (const key of deviceHistoryKeys) {
    const hex = signingKeyHex(key);
    if (hex) history.add(hex);
  }
  const accepted: string[] = [];
  const seen = new Set<string>();
  for (const claimed of claimedKeys) {
    const hex = signingKeyHex(claimed);
    if (!hex || !history.has(hex) || seen.has(hex)) continue;
    seen.add(hex);
    accepted.push(hex);
  }
  return Object.freeze(accepted);
};

// Open the owner's generation-1 User Value Key. A project-epoch envelope, a
// different owner, or a different generation does not open.
export const openOwnedUserValueKey = async (
  envelopeBytes: Uint8Array,
  accountMasterKey: Uint8Array,
  input: Readonly<{
    readonly trustedKeys: AccountKeyTrustedKeys;
    readonly context: AccountKeyVerificationContext;
    readonly ownerUserId: Uint8Array;
  }>,
): Promise<Uint8Array | null> => {
  let envelope: ReturnType<typeof parseAccountKeyEnvelope>;
  try {
    envelope = parseAccountKeyEnvelope(envelopeBytes);
  } catch {
    return null;
  }
  if (
    envelope.envelopeType !== KEY_ENVELOPE_TYPE.userValueKey ||
    envelope.ownerUserId === undefined ||
    envelope.valueGeneration !== USER_VALUE_KEY_GENERATION ||
    !sameBytes(envelope.ownerUserId, input.ownerUserId)
  )
    return null;
  try {
    return await openAccountKeyEnvelope(envelope, accountMasterKey, {
      trustedKeys: input.trustedKeys,
      context: {
        ...input.context,
        envelopeType: envelope.envelopeType,
        ownerUserId: input.ownerUserId,
        valueGeneration: USER_VALUE_KEY_GENERATION,
      },
    });
  } catch {
    return null;
  }
};
