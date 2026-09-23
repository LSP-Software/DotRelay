import {
  createBrowserDeviceStorage,
  createProtocolTransport,
  loadDeviceKeyMaterial,
  openProjectEpochGrant,
  type RevisionSigningTrustEntry,
  uuidToBytes,
} from "@dotrelay/client";
import {
  type AccountKeyActor,
  type AccountKeyWrapperEntry,
  createAccountKeyEnvelope,
  fromBase64,
  hexToBytes,
  openProjectEpochEnvelope,
  publishAccountKeyEnvelope,
} from "@/lib/account-keys";
import {
  accountKeyVerification,
  loadDeviceSigningKey,
} from "@/lib/account-recovery";
import { readStoredBrowserDeviceId } from "@/lib/browser-storage";
import {
  environmentContextIdentity,
  environmentContextKey,
} from "@/lib/environment-context";
import {
  createEnvironmentProtocolSession,
  type EnvironmentProtocolSession,
} from "@/lib/environment-protocol-session";
import { resolveUserValueKey } from "@/lib/user-value-key";
import {
  fetchWorkspaceBoundary,
  type WorkspaceBoundary,
  type WorkspaceProfileId,
} from "@/lib/workspace-boundary";

// The workspace's session machinery: the periodic boundary refresh loop
// (with its exponential reconnect backoff and the plain-refresh path that
// establishes the project's Account Key Envelope from an in-session
// account-key unlock) and the per-environment protocol session loader (key
// loading from this browser's Device storage, revision signing trust, and
// the shared value secret from a grant, the Account Key Envelope, or a
// last-resort self-mint).
//
// Both are registration-free: the shell owns the useEffects, their
// dependency lists, and the state these contexts write to.

const WORKSPACE_REFRESH_MS = Math.max(
  Number(process.env.NEXT_PUBLIC_DOTRELAY_WORKSPACE_REFRESH_MS ?? 0) || 30_000,
  1_000,
);
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

type WorkspaceRefreshContext = Readonly<{
  readonly profileId: WorkspaceProfileId;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  readonly boundary: WorkspaceBoundary;
  readonly recoveryWrappers: readonly AccountKeyWrapperEntry[];
  // accountUnlocked mirrors accountMasterKey; the effect reads the ref.
  readonly accountUnlocked: boolean;
  readonly apiOrigin: string | undefined;
  readonly boundaryJson: {
    readonly get: () => string;
    readonly set: (value: string) => void;
  };
  readonly accountMasterKey: { readonly get: () => Uint8Array | null };
  readonly reconnectNowRef: { current: (() => void) | null };
  readonly setConnection: (
    connection: "loading" | "online" | "offline",
  ) => void;
  readonly setVerifiedAt: (verifiedAt: number) => void;
  readonly setBoundary: (boundary: WorkspaceBoundary) => void;
  readonly removeSessionByKey: (key: string) => void;
}>;

export const createWorkspaceRefreshLoop = (
  ctx: WorkspaceRefreshContext,
): Readonly<{
  readonly reconnectNow: () => void;
  readonly dispose: () => void;
}> => {
  const {
    profileId,
    teamId,
    projectId,
    environmentId,
    boundary,
    recoveryWrappers,
    apiOrigin,
    boundaryJson,
    accountMasterKey,
    reconnectNowRef,
    setConnection,
    setVerifiedAt,
    setBoundary,
    removeSessionByKey,
  } = ctx;
  let cancelled = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = RECONNECT_BASE_MS;
  const stale = (run: number) => cancelled || run !== generation;
  const loadOnce = async (run: number): Promise<boolean> => {
    try {
      const fetched = await fetchWorkspaceBoundary(profileId, {
        ...(environmentId ? { environmentId } : {}),
      });
      if (stale(run)) return false;
      if (fetched.connection !== "online") {
        setConnection("offline");
        return false;
      }
      const serverProfileId = fetched.profile.serverProfileId;
      const storedId = serverProfileId
        ? readStoredBrowserDeviceId(fetched.profile.origin, serverProfileId)
        : null;
      const resolved =
        storedId && storedId !== fetched.device.id
          ? await fetchWorkspaceBoundary(profileId, {
              deviceId: storedId,
              ...(environmentId ? { environmentId } : {}),
            })
          : fetched;
      if (stale(run)) return false;
      if (resolved.connection !== "online") {
        setConnection("offline");
        return false;
      }
      setVerifiedAt(Date.now());
      setConnection("online");
      const resolvedJson = JSON.stringify(resolved);
      if (resolvedJson !== boundaryJson.get()) {
        boundaryJson.set(resolvedJson);
        setBoundary(resolved);
      }
      // A plain refresh (no Device actor) still establishes the
      // Project Epoch Key when the account is unlocked in this session
      // and no Device holds the current epoch's key: the envelope is the
      // only path by which the in-memory key reaches the server. A
      // failure here must not take the boundary offline.
      try {
        const masterKey = accountMasterKey.get();
        if (
          storedId === null &&
          masterKey &&
          resolved.connection === "online" &&
          !resolved.grantsReady &&
          !(resolved.peerDevices ?? []).some((peer) => peer.hasEpochGrant) &&
          resolved.environment.projectId
        ) {
          const environment = resolved.environment;
          const verification = accountKeyVerification(
            boundary,
            recoveryWrappers,
          );
          const signingPrivateKey = await loadDeviceSigningKey(boundary);
          if (
            verification &&
            signingPrivateKey &&
            resolved.profile.serverProfileId &&
            resolved.device.id &&
            environment.projectId
          ) {
            const bundle = await createBrowserDeviceStorage({
              serverProfileId: resolved.profile.serverProfileId,
              origin: resolved.profile.origin,
            }).load({
              pin: {
                serverProfileId: resolved.profile.serverProfileId,
                origin: resolved.profile.origin,
              },
              deviceId: uuidToBytes(resolved.device.id),
            });
            const projectEpoch = Number(environment.projectEpoch ?? 1);
            const epochKey = globalThis.crypto.getRandomValues(
              new Uint8Array(32),
            );
            const envelope = await createAccountKeyEnvelope({
              serverProfileId: resolved.profile.serverProfileId,
              userId: bundle.userId,
              deviceId: uuidToBytes(resolved.device.id),
              createdAtMs: Date.now(),
              accountMasterKey: masterKey,
              signingPrivateKey,
              kind: {
                type: "projectEpochKey",
                projectId: uuidToBytes(environment.projectId),
                projectEpoch,
                contentKey: epochKey,
              },
            });
            try {
              await publishAccountKeyEnvelope(
                {
                  origin: apiOrigin ?? resolved.profile.origin,
                  deviceId: resolved.device.id,
                },
                globalThis.crypto.randomUUID(),
                envelope,
                {
                  envelopeType: "PROJECT_EPOCH_KEY",
                  projectId: environment.projectId,
                  projectEpoch,
                },
              );
            } catch {
              // A refusal (for example the peer holds the key in the
              // meantime) leaves the prior state in place; the next
              // refresh rechecks.
            }
          }
        }
      } catch {
        // Storage or key material that is missing on this browser
        // can't be repaired from a refresh; the actor-bound paths
        // surface those to the user instead.
      }
      if (!storedId) {
        removeSessionByKey(
          environmentContextKey(
            environmentContextIdentity({
              profileId,
              serverProfileId: resolved.profile.serverProfileId,
              teamId,
              projectId,
              environmentId,
            }),
          ),
        );
      }
      return true;
    } catch {
      if (!stale(run)) setConnection("offline");
      return false;
    }
  };
  const tick = async () => {
    const run = ++generation;
    const online = await loadOnce(run);
    if (stale(run)) return;
    if (online) {
      reconnectDelay = RECONNECT_BASE_MS;
      timer = setTimeout(() => void tick(), WORKSPACE_REFRESH_MS);
    } else {
      timer = setTimeout(() => void tick(), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }
  };
  const reconnectNow = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    reconnectDelay = RECONNECT_BASE_MS;
    void tick();
  };
  reconnectNowRef.current = reconnectNow;
  void tick();
  const dispose = () => {
    cancelled = true;
    reconnectNowRef.current = null;
    if (timer !== undefined) clearTimeout(timer);
  };
  return { reconnectNow, dispose };
};

type WorkspaceSessionContext = Readonly<{
  readonly boundary: WorkspaceBoundary;
  readonly profileId: WorkspaceProfileId;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  readonly recoveryWrappers: readonly AccountKeyWrapperEntry[];
  readonly recoveryActor: AccountKeyActor | null;
  readonly accountMasterKey: { readonly get: () => Uint8Array | null };
  readonly durableBrowserDevice: { readonly add: (key: string) => void };
  readonly removeSessionByKey: (key: string) => void;
  readonly setSessionsByKey: (
    update: (
      prev: ReadonlyMap<string, EnvironmentProtocolSession>,
    ) => Map<string, EnvironmentProtocolSession>,
  ) => void;
  readonly setContextStale: (stale: boolean) => void;
}>;

export const loadWorkspaceSession = (
  ctx: WorkspaceSessionContext,
  cancelled: boolean,
): void => {
  const {
    boundary,
    profileId,
    teamId,
    projectId,
    environmentId,
    recoveryWrappers,
    recoveryActor,
    accountMasterKey,
    durableBrowserDevice,
    removeSessionByKey,
    setSessionsByKey,
    setContextStale,
  } = ctx;
  const targetKey = environmentContextKey(
    environmentContextIdentity({
      profileId,
      serverProfileId: boundary.profile.serverProfileId,
      teamId,
      projectId,
      environmentId,
    }),
  );
  const boundaryMatchesSelection =
    environmentId === null ||
    (boundary.environment.id === environmentId &&
      boundary.environment.projectId === projectId &&
      boundary.environment.teamId === teamId);
  const clearSelectedSession = () => {
    if (cancelled) return;
    removeSessionByKey(targetKey);
  };
  const settleContext = () => {
    if (!cancelled) setContextStale(false);
  };
  const loadSession = async () => {
    const environment = boundary.environment;
    const device = boundary.device;
    const profile = boundary.profile;
    if (
      !boundary.session.userId ||
      !profile.serverProfileId ||
      !device.active ||
      !device.id ||
      !device.encryptionPublicKey ||
      !device.signingPublicKey ||
      !environment.id ||
      !environment.projectId ||
      !environment.teamId
    ) {
      clearSelectedSession();
      if (boundaryMatchesSelection) settleContext();
      return;
    }
    try {
      const pin = {
        serverProfileId: profile.serverProfileId,
        origin: profile.origin,
      };
      const storage = createBrowserDeviceStorage(pin);
      const durable = storage.durable;
      const bundle = await storage.load({
        pin,
        deviceId: uuidToBytes(device.id),
      });
      const keyMaterial = await loadDeviceKeyMaterial(bundle);
      if (!keyMaterial.encryptionPublicKey)
        throw new Error("stored Device public key is missing");
      let userDefinedValueSecret: Uint8Array | undefined;
      const userValueMaster = accountMasterKey.get();
      const ownerUserIdText = boundary.session.userId;
      if (userValueMaster && ownerUserIdText && recoveryActor) {
        const verification = accountKeyVerification(boundary, recoveryWrappers);
        const signingPrivateKey = await loadDeviceSigningKey(boundary);
        if (verification && signingPrivateKey && profile.serverProfileId) {
          const valueBundle = await storage.load({
            pin,
            deviceId: uuidToBytes(device.id),
          });
          const opened = await resolveUserValueKey({
            actor: recoveryActor,
            boundary,
            accountMasterKey: userValueMaster,
            signingPrivateKey,
            trustedKeys: verification.trustedKeys,
            context: verification.context,
            ownerUserId: valueBundle.userId,
            ownerUserIdText,
            serverProfileId: profile.serverProfileId,
            deviceId: uuidToBytes(device.id),
            ...(boundary.userValueKeyEnvelope
              ? { listedEnvelope: boundary.userValueKeyEnvelope }
              : {}),
          }).catch(() => null);
          if (opened) userDefinedValueSecret = opened;
        }
      }
      const expectedHeadId =
        boundary.environment.headRevision === "empty-environment"
          ? null
          : boundary.environment.headRevision;
      const context = {
        serverProfileId: profile.serverProfileId,
        teamId: environment.teamId,
        projectId: environment.projectId,
        environmentId: environment.id,
        actorUserId: boundary.session.userId,
        actorDeviceId: device.id,
        projectEpoch: Number(environment.projectEpoch ?? 1),
        expectedHeadId,
        expectedHeadHash: environment.headHash
          ? hexToBytes(environment.headHash)
          : null,
        trustedRevisionId: environment.id,
        trustedRevisionHash: new Uint8Array(48),
        valueRecipientPublicKey: keyMaterial.encryptionPublicKey,
        userDefinedValueRecipientPublicKey: keyMaterial.encryptionPublicKey,
        signingPrivateKey: keyMaterial.signingPrivateKey,
        revisionSigningPublicKey: hexToBytes(device.signingPublicKey),
        ...(userDefinedValueSecret ? { userDefinedValueSecret } : {}),
      };
      const transport = createProtocolTransport({ origin: profile.origin });
      const signingTrustKeys = (boundary.signingTrustKeys ?? [])
        .map((key) => {
          try {
            return hexToBytes(key);
          } catch {
            return null;
          }
        })
        .filter((key): key is Uint8Array => key !== null);
      const signingTrustDevices: (RevisionSigningTrustEntry | null)[] = (
        boundary.signingTrustDevices ?? []
      ).map((device) => {
        let publicKey: Uint8Array;
        try {
          publicKey = hexToBytes(device.signingPublicKey);
        } catch {
          return null;
        }
        return {
          publicKey,
          ...(device.deviceId ? { deviceId: device.deviceId } : {}),
          ...(device.userId ? { userId: device.userId } : {}),
          deviceActiveFromMs: device.deviceActiveFromMs,
          deviceActiveUntilMs: device.deviceActiveUntilMs,
          memberSinceMs: device.memberSinceMs,
          memberUntilMs: device.memberUntilMs,
        };
      });
      const scopedSigningTrustDevices = signingTrustDevices.filter(
        (device): device is RevisionSigningTrustEntry => device !== null,
      );
      let sharedValueSecret: Uint8Array | undefined;
      if (boundary.epochGrant) {
        try {
          sharedValueSecret = await openProjectEpochGrant(
            fromBase64(boundary.epochGrant),
            keyMaterial.encryptionPrivateKey,
          );
        } catch {
          sharedValueSecret = undefined;
        }
      }
      // A session that unlocked the Account Master Key in this browser
      // (setup or unlock in the Recovery area) reads the project's
      // current epoch key from the boundary's Account Key Envelope, so a
      // Device without a direct grant still decrypts pre-existing
      // content. A mismatch or verification failure leaves the secret
      // unset: the session then degrades exactly like a Device that
      // simply lacks the key, and the setup action names the fix.
      const envelopeKeyMaster = accountMasterKey.get();
      if (
        sharedValueSecret === undefined &&
        boundary.accountKeyEnvelope &&
        envelopeKeyMaster &&
        boundary.device.signingPublicKey
      ) {
        const verification = accountKeyVerification(boundary, recoveryWrappers);
        if (verification) {
          const projectEpoch = Number(environment.projectEpoch ?? 1);
          const envelopeKey = await openProjectEpochEnvelope(
            boundary.accountKeyEnvelope,
            envelopeKeyMaster,
            {
              trustedKeys: verification.trustedKeys,
              context: verification.context,
              projectId: environment.projectId,
              projectEpoch,
            },
          );
          if (envelopeKey) sharedValueSecret = envelopeKey;
        }
      }
      // The last-resort self-mint, mirroring the CLI: only when the
      // account key is unlocked, no Device holds this epoch's key, and
      // no peer holds one — otherwise a fresh random key could never
      // decrypt pre-existing content and would block the peer re-share.
      const selfMintKey = accountMasterKey.get();
      if (
        sharedValueSecret === undefined &&
        selfMintKey &&
        !boundary.grantsReady &&
        !(boundary.peerDevices ?? []).some((peer) => peer.hasEpochGrant)
      ) {
        const actor = recoveryActor;
        const signingPrivateKey = await loadDeviceSigningKey(boundary);
        const verification = accountKeyVerification(boundary, recoveryWrappers);
        if (
          actor &&
          signingPrivateKey &&
          verification &&
          environment.projectId
        ) {
          const bundle = await createBrowserDeviceStorage(pin).load({
            pin,
            deviceId: uuidToBytes(device.id),
          });
          const projectEpoch = Number(environment.projectEpoch ?? 1);
          const epochKey = globalThis.crypto.getRandomValues(
            new Uint8Array(32),
          );
          const envelope = await createAccountKeyEnvelope({
            serverProfileId: profile.serverProfileId,
            userId: bundle.userId,
            deviceId: uuidToBytes(device.id),
            createdAtMs: Date.now(),
            accountMasterKey: selfMintKey,
            signingPrivateKey,
            kind: {
              type: "projectEpochKey",
              projectId: uuidToBytes(environment.projectId),
              projectEpoch,
              contentKey: epochKey,
            },
          });
          await publishAccountKeyEnvelope(
            actor,
            globalThis.crypto.randomUUID(),
            envelope,
            {
              envelopeType: "PROJECT_EPOCH_KEY",
              projectId: environment.projectId,
              projectEpoch,
            },
          );
          sharedValueSecret = epochKey;
        }
      }
      const session = createEnvironmentProtocolSession({
        context,
        transport,
        sharedValuePrivateKey: keyMaterial.encryptionPrivateKey,
        userDefinedValuePrivateKey: keyMaterial.encryptionPrivateKey,
        signingTrustKeys:
          scopedSigningTrustDevices.length > 0
            ? scopedSigningTrustDevices
            : signingTrustKeys.length > 0
              ? signingTrustKeys
              : [hexToBytes(device.signingPublicKey)],
        ...(sharedValueSecret ? { sharedValueSecret } : {}),
        ...(userDefinedValueSecret ? { userDefinedValueSecret } : {}),
      });
      if (cancelled) return;
      if (
        environment.id !== environmentId ||
        environment.projectId !== projectId ||
        environment.teamId !== teamId
      ) {
        clearSelectedSession();
        return;
      }
      if (durable)
        durableBrowserDevice.add(`${pin.origin}\u0000${pin.serverProfileId}`);
      setSessionsByKey((prev) => new Map(prev).set(targetKey, session));
      settleContext();
    } catch {
      clearSelectedSession();
      if (boundaryMatchesSelection) settleContext();
    }
  };
  void loadSession();
};
