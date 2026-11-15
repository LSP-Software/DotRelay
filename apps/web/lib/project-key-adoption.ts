import {
  type AccountTrustPins,
  assertProjectEpochCurrent,
  openProjectEpochGrant,
  pinProjectEpochKeys,
} from "@dotrelay/client";
import {
  type AccountKeyWrapperEntry,
  fromBase64,
  openProjectEpochEnvelope,
  projectGrantVerification,
} from "./account-keys";
import { accountKeyVerification } from "./account-recovery";
import type { WorkspaceBoundary } from "./workspace-boundary";

export type ProjectPinStore = Readonly<{
  load: () => Promise<AccountTrustPins>;
  save: (pins: AccountTrustPins) => Promise<void>;
}>;

// The Project Epoch Key this browser reads and seals with for the boundary's
// Project and epoch (ADR 0022). Mirrors the CLI's session:
//
// - the Project epoch may never be older than one this browser accepted;
// - the account's own Account Key Envelope, sealed under its Account Master
//   Key, wins over a grant, because the service cannot choose its key;
// - a grant counts only when an active Device of this account, or of a
//   teammate the user confirmed, signed it;
// - whichever source delivered it, a key for an epoch this browser already
//   pinned must be that same key, and a new one is pinned.
//
// Throws ProjectEpochTrustError when the service contradicts the pins.
export const adoptProjectEpochKey = async (
  input: Readonly<{
    readonly boundary: WorkspaceBoundary;
    readonly accountMasterKey: Uint8Array | null;
    readonly encryptionPrivateKey: CryptoKey;
    readonly wrappers: readonly AccountKeyWrapperEntry[];
    readonly pinStore: ProjectPinStore;
  }>,
): Promise<Uint8Array | undefined> => {
  const { boundary } = input;
  const environment = boundary.environment;
  const projectId = environment.projectId;
  const serverProfileId = boundary.profile.serverProfileId;
  if (!projectId || !serverProfileId) return undefined;
  const epoch = Number(environment.projectEpoch ?? 1);
  const pins = await input.pinStore.load();
  assertProjectEpochCurrent(pins, projectId, epoch);
  let key: Uint8Array | undefined;
  if (boundary.accountKeyEnvelope && input.accountMasterKey) {
    const verification = accountKeyVerification(boundary, input.wrappers);
    if (verification)
      key =
        (await openProjectEpochEnvelope(
          boundary.accountKeyEnvelope,
          input.accountMasterKey,
          {
            trustedKeys: verification.trustedKeys,
            context: verification.context,
            projectId,
            projectEpoch: epoch,
          },
        )) ?? undefined;
  }
  if (key === undefined && boundary.epochGrant) {
    try {
      key = await openProjectEpochGrant(
        fromBase64(boundary.epochGrant),
        input.encryptionPrivateKey,
        projectGrantVerification(boundary),
      );
    } catch {
      key = undefined;
    }
  }
  if (key === undefined) return undefined;
  const pinned = await pinProjectEpochKeys(pins, {
    serverProfileId,
    projectId,
    currentEpoch: epoch,
    keys: new Map([[epoch, key]]),
  });
  if (pinned.changed) await input.pinStore.save(pinned.pins);
  return key;
};

/** True when this browser already pinned a key for the Project's epoch. */
export const projectEpochKeyPinned = (
  pins: AccountTrustPins,
  projectId: string,
  epoch: number,
): boolean =>
  Object.hasOwn(
    pins.projects?.[projectId.toLowerCase()]?.keys ?? {},
    String(epoch),
  );

/**
 * Checks and records the earlier epoch keys the key chain rebuilt: each must
 * match what this browser pinned for its epoch.
 */
export const pinProjectEpochRing = async (
  pinStore: ProjectPinStore,
  input: Readonly<{
    readonly serverProfileId: string;
    readonly projectId: string;
    readonly currentEpoch: number;
    readonly ring: ReadonlyMap<number, Uint8Array>;
  }>,
): Promise<void> => {
  const pinned = await pinProjectEpochKeys(await pinStore.load(), {
    serverProfileId: input.serverProfileId,
    projectId: input.projectId,
    currentEpoch: input.currentEpoch,
    keys: input.ring,
  });
  if (pinned.changed) await pinStore.save(pinned.pins);
};
