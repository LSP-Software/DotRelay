import {
  authenticatedCreatorKeys,
  createAccountKeyEnvelope,
  deviceHistorySigningKeys,
  openOwnedUserValueKey,
  USER_VALUE_KEY_GENERATION,
} from "@dotrelay/client";
import {
  type AccountKeyActor,
  AccountKeyRequestError,
  type AccountKeyTrustedKeys,
  type AccountKeyVerificationContext,
  fetchAccountKeyEnvelopes,
  fromBase64,
  publishAccountKeyEnvelope,
} from "@/lib/account-keys";
import type { WorkspaceBoundary } from "@/lib/workspace-boundary";

const openListed = async (
  object: string,
  accountMasterKey: Uint8Array,
  trustedKeys: AccountKeyTrustedKeys,
  context: AccountKeyVerificationContext,
  ownerUserId: Uint8Array,
  claimedCreatorKey: string | undefined,
  boundary: WorkspaceBoundary,
): Promise<Uint8Array | null> => {
  const extras = authenticatedCreatorKeys(
    claimedCreatorKey ? [claimedCreatorKey] : [],
    deviceHistorySigningKeys(boundary),
  );
  const keys =
    extras.length === 0
      ? trustedKeys
      : {
          keys: [
            ...trustedKeys.keys,
            ...extras.map((hex) => fromBase64Hex(hex)),
          ],
        };
  return openOwnedUserValueKey(fromBase64(object), accountMasterKey, {
    trustedKeys: keys,
    context,
    ownerUserId,
  });
};

const fromBase64Hex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

// Open the owner's User Value Key, or publish generation 1 when this Device
// is the first to establish it. A losing publish fetches the winner and opens
// that envelope. The claimed creator key is ignored unless device history
// already contains it.
export const resolveUserValueKey = async (
  input: Readonly<{
    readonly actor: AccountKeyActor;
    readonly boundary: WorkspaceBoundary;
    readonly accountMasterKey: Uint8Array;
    readonly signingPrivateKey: CryptoKey;
    readonly trustedKeys: AccountKeyTrustedKeys;
    readonly context: AccountKeyVerificationContext;
    readonly ownerUserId: Uint8Array;
    readonly ownerUserIdText: string;
    readonly serverProfileId: string;
    readonly deviceId: Uint8Array;
    readonly listedEnvelope?: string;
  }>,
): Promise<Uint8Array | null> => {
  if (input.listedEnvelope) {
    const opened = await openListed(
      input.listedEnvelope,
      input.accountMasterKey,
      input.trustedKeys,
      input.context,
      input.ownerUserId,
      undefined,
      input.boundary,
    );
    if (opened) return opened;
  }
  const contentKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const envelope = await createAccountKeyEnvelope({
    serverProfileId: input.serverProfileId,
    userId: input.ownerUserId,
    deviceId: input.deviceId,
    createdAtMs: Date.now(),
    accountMasterKey: input.accountMasterKey,
    signingPrivateKey: input.signingPrivateKey,
    kind: {
      type: "userValueKey",
      ownerUserId: input.ownerUserId,
      valueGeneration: USER_VALUE_KEY_GENERATION,
      contentKey,
    },
  });
  try {
    await publishAccountKeyEnvelope(
      input.actor,
      globalThis.crypto.randomUUID(),
      envelope,
      {
        envelopeType: "USER_VALUE_KEY",
        ownerUserId: input.ownerUserIdText,
        valueGeneration: USER_VALUE_KEY_GENERATION,
      },
    );
    return contentKey;
  } catch (error) {
    if (
      !(error instanceof AccountKeyRequestError) ||
      error.code !== "state_conflict"
    )
      return null;
  }
  try {
    const envelopes = await fetchAccountKeyEnvelopes(input.actor);
    for (const entry of envelopes) {
      if (
        entry.envelopeType !== "user-value-key" ||
        entry.valueGeneration !== String(USER_VALUE_KEY_GENERATION)
      )
        continue;
      const opened = await openListed(
        entry.object,
        input.accountMasterKey,
        input.trustedKeys,
        input.context,
        input.ownerUserId,
        entry.creatorPublicKey,
        input.boundary,
      );
      if (opened) return opened;
    }
  } catch {
    return null;
  }
  return null;
};
