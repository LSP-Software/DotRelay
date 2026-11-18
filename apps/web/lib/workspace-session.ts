import {
  createBrowserDeviceStorage,
  createProjectEpochKeyLinkBackfill,
  createProtocolTransport,
  loadDeviceKeyMaterial,
  openProjectEpochKeyChain,
  ownSigningTrust,
  ProjectEpochTrustError,
  uuidToBytes,
} from "@dotrelay/client";
import {
  type AccountKeyActor,
  type AccountKeyWrapperEntry,
  createAccountKeyEnvelope,
  fetchAccountKeyEnvelopes,
  fromBase64,
  hexToBytes,
  historySigningKeys,
  openProjectEpochEnvelope,
  publishAccountKeyEnvelope,
  publishProjectEpochKeyLink,
} from "@/lib/account-keys";
import {
  accountKeyVerification,
  loadDeviceSigningKey,
} from "@/lib/account-recovery";
import { readStoredBrowserDeviceId } from "@/lib/browser-storage";
import {
  AccountRosterUntrustedError,
  establishBrowserAccountTrust,
  loadBrowserAccountTrustPins,
  saveBrowserAccountTrustPins,
} from "@/lib/account-trust";
import {
  adoptProjectEpochKey,
  pinProjectEpochRing,
  projectEpochKeyPinned,
} from "@/lib/project-key-adoption";
import { describeThisBrowser } from "@/lib/device-describe";
import {
  environmentContextIdentity,
  environmentContextKey,
} from "@/lib/environment-context";
import {
  createEnvironmentProtocolSession,
  deviceAuthoredAtNotBeforeMs,
  type EnvironmentProtocolSession,
  revisionSigningTrustEntries,
} from "@/lib/environment-protocol-session";
import { resolveUserValueKey } from "@/lib/user-value-key";
import {
  browserDeviceProof,
  fetchDeviceBoundary,
  fetchWithDeviceProof,
  knownDeviceProof,
} from "@/lib/device-proof";
import {
  BROWSER_DEVICE_ID_HEADER,
  fetchWorkspaceBoundary,
  type WorkspaceBoundary,
  type WorkspaceProfileId,
} from "@/lib/workspace-boundary";

// Devices this page already described. The fields only change with a new
// browser version, so once per page load is enough; describing on every
// boundary tick sent a write every two seconds during setup.
const describedDevices = new Set<string>();

// Best-effort self-describe: refreshes this browser's display name and
// client fields on the Server Profile after the boundary is known. Failures
// must not take the session offline; the next tick retries.
const refreshDeviceDisplay = async (
  apiOrigin: string,
  deviceId: string,
): Promise<void> => {
  const key = `${apiOrigin}\n${deviceId}`;
  if (describedDevices.has(key)) return;
  try {
    const info = describeThisBrowser();
    const response = await fetchWithDeviceProof(
      knownDeviceProof(apiOrigin, deviceId),
      `${apiOrigin}/api/v1/devices/self`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          [BROWSER_DEVICE_ID_HEADER]: deviceId,
        },
        body: JSON.stringify({
          client: {
            displayName: info.displayName,
            clientKind: info.clientKind,
            ...(info.osName ? { osName: info.osName } : {}),
            ...(info.clientSummary
              ? { clientSummary: info.clientSummary }
              : {}),
          },
        }),
      },
    );
    if (response.ok) describedDevices.add(key);
  } catch {
    // display metadata is cosmetic; ignore network and parse failures
  }
};

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
// First-run steps finish in another window (CLI setup, sign-in, init).
// The ordinary interval is too slow, and a background tab may not run it
// at all, so an unfinished checklist polls on this shorter cadence.
const SETUP_BOUNDARY_REFRESH_MS = 2_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

// Rebuilds the Project's epoch key ring from the key chain (ADR 0014), walking
// down from the current key. When links are missing and the Account Master
// Key is unlocked, the User's past-epoch Account Key Envelopes are only the
// backfill source: the missing links are published and the chain walked
// again. Mirrors projectEpochKeyRing in the CLI.
const projectEpochKeyRing = async (input: {
  readonly boundary: WorkspaceBoundary;
  readonly serverProfileId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly currentEpoch: number;
  readonly currentKey: Uint8Array;
  readonly backfill: Readonly<{
    readonly actor: AccountKeyActor;
    readonly recoveryWrappers: readonly AccountKeyWrapperEntry[];
    readonly accountMasterKey: Uint8Array;
  }> | null;
}): Promise<Map<number, Uint8Array>> => {
  const { boundary } = input;
  const deviceId = boundary.device.id;
  const localKey = boundary.device.signingPublicKey;
  if (!deviceId || !localKey) return new Map();
  const links: Uint8Array[] = [];
  for (const link of boundary.epochKeyLinks ?? []) {
    try {
      links.push(fromBase64(link));
    } catch {
      // A malformed entry claims no epoch.
    }
  }
  const binding = {
    serverProfileId: input.serverProfileId,
    teamId: input.teamId,
    projectId: input.projectId,
  };
  const trustedSigningKeys = historySigningKeys(boundary, hexToBytes(localKey));
  const walk = (candidates: readonly Uint8Array[]) =>
    openProjectEpochKeyChain({
      ...binding,
      links: candidates,
      currentEpoch: input.currentEpoch,
      currentKey: input.currentKey,
      trustedSigningKeys,
    });
  const chain = await walk(links);
  if (chain.break?.reason !== "missing" || !input.backfill)
    return new Map(chain.ring);
  const signingPrivateKey = await loadDeviceSigningKey(boundary);
  if (!signingPrivateKey) return new Map(chain.ring);
  const past = await pastProjectEpochKeys({
    ...input.backfill,
    boundary,
    projectId: input.projectId,
    currentEpoch: input.currentEpoch,
  });
  const created = await createProjectEpochKeyLinkBackfill({
    ...binding,
    links,
    currentEpoch: input.currentEpoch,
    knownKeys: new Map([...past, ...chain.ring]),
    signingDeviceId: deviceId,
    signingPrivateKey,
  });
  const published: Uint8Array[] = [];
  for (const link of created) {
    try {
      await publishProjectEpochKeyLink(
        input.backfill.actor,
        input.projectId,
        link,
      );
      published.push(link.canonicalBytes);
    } catch {
      // Another client may have won this epoch; its link arrives next refresh.
    }
  }
  return new Map(
    published.length > 0
      ? (await walk([...links, ...published])).ring
      : chain.ring,
  );
};

// Opens this User's Account Key Envelopes for the Project's earlier epochs.
// They are only the backfill source for missing key chain links; an envelope
// that fails verification contributes no key.
const pastProjectEpochKeys = async (input: {
  readonly actor: AccountKeyActor;
  readonly boundary: WorkspaceBoundary;
  readonly recoveryWrappers: readonly AccountKeyWrapperEntry[];
  readonly accountMasterKey: Uint8Array;
  readonly projectId: string;
  readonly currentEpoch: number;
}): Promise<Map<number, Uint8Array>> => {
  const ring = new Map<number, Uint8Array>();
  if (input.currentEpoch <= 1) return ring;
  let envelopes: Awaited<ReturnType<typeof fetchAccountKeyEnvelopes>>;
  try {
    envelopes = await fetchAccountKeyEnvelopes(input.actor);
  } catch {
    return ring;
  }
  const verification = accountKeyVerification(input.boundary, [
    ...input.recoveryWrappers,
    ...envelopes,
  ]);
  if (!verification) return ring;
  for (const entry of envelopes) {
    const epoch = Number(entry.projectEpoch);
    if (
      entry.envelopeType !== "project-epoch-key" ||
      entry.projectId !== input.projectId ||
      !Number.isSafeInteger(epoch) ||
      epoch < 1 ||
      epoch >= input.currentEpoch ||
      ring.has(epoch)
    )
      continue;
    // The envelope's own signed Project and epoch must match the listing.
    const key = await openProjectEpochEnvelope(
      entry.object,
      input.accountMasterKey,
      {
        trustedKeys: verification.trustedKeys,
        context: verification.context,
        projectId: input.projectId,
        projectEpoch: epoch,
      },
    );
    if (key) ring.set(epoch, key);
  }
  return ring;
};

export const workspaceBoundaryRefreshMs = (setupPending: boolean): number =>
  setupPending
    ? Math.min(WORKSPACE_REFRESH_MS, SETUP_BOUNDARY_REFRESH_MS)
    : WORKSPACE_REFRESH_MS;

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
  readonly refreshMs: number;
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
    refreshMs,
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
      // The Device's view needs a proof that this browser holds the stored
      // Device's key (ADR 0020). A Device the service refuses, or whose key
      // this browser lost, leaves the session view, which reports no Device.
      const resolved =
        storedId && serverProfileId && apiOrigin
          ? await fetchDeviceBoundary(
              profileId,
              {
                apiOrigin,
                pin: { origin: fetched.profile.origin, serverProfileId },
                deviceId: storedId,
              },
              environmentId,
            )
          : fetched;
      if (stale(run)) return false;
      if (resolved.connection !== "online") {
        setConnection("offline");
        return false;
      }
      if (resolved.device.active && resolved.device.id && apiOrigin)
        await refreshDeviceDisplay(apiOrigin, resolved.device.id);
      // A newer refresh may have finished while this one was still reading
      // the server. Committing now would put the checklist back a step.
      if (stale(run)) return false;
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
      timer = setTimeout(() => void tick(), refreshMs);
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
  /**
   * Reports why the Server Profile's account or Project keys were refused
   * (ADR 0015, ADR 0022), or null once a session loads.
   */
  readonly setTrustProblem?: (message: string | null) => void;
}>;

// What the person is told when this browser refuses the service's keys.
export const trustProblemMessage = (error: unknown): string | null =>
  error instanceof AccountRosterUntrustedError
    ? error.message
    : error instanceof ProjectEpochTrustError
      ? error.code === "epoch-rollback"
        ? "The server reports an older project key than this browser already used. Don't publish from this browser until you've checked the server."
        : "The server sent a project key that differs from the one this browser already verified. Don't trust this server until you've checked it."
      : null;

export const loadWorkspaceSession = (
  ctx: WorkspaceSessionContext,
  // A ref, not a boolean: the caller's effect cleanup flips it after this
  // loader has started, and every await below must observe that.
  cancellation: { readonly current: boolean },
): Promise<void> => {
  const {
    boundary: untrustedBoundary,
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
    setTrustProblem,
  } = ctx;
  const targetKey = environmentContextKey(
    environmentContextIdentity({
      profileId,
      serverProfileId: untrustedBoundary.profile.serverProfileId,
      teamId,
      projectId,
      environmentId,
    }),
  );
  const boundaryMatchesSelection =
    environmentId === null ||
    (untrustedBoundary.environment.id === environmentId &&
      untrustedBoundary.environment.projectId === projectId &&
      untrustedBoundary.environment.teamId === teamId);
  const cancelled = () => cancellation.current;
  const clearSelectedSession = () => {
    if (cancelled()) return;
    removeSessionByKey(targetKey);
  };
  const settleContext = () => {
    if (!cancelled()) setContextStale(false);
  };
  const loadSession = async () => {
    const environment = untrustedBoundary.environment;
    const device = untrustedBoundary.device;
    const profile = untrustedBoundary.profile;
    if (
      !untrustedBoundary.session.userId ||
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
      if (cancelled()) return;
      const keyMaterial = await loadDeviceKeyMaterial(bundle);
      if (cancelled()) return;
      if (!keyMaterial.encryptionPublicKey)
        throw new Error("stored Device public key is missing");
      // ADR 0015: from here on every key list comes from a verified Account
      // Device roster. A roster this account's key did not sign closes the
      // session instead of trusting the service's Device list.
      const { boundary } = await establishBrowserAccountTrust({
        boundary: untrustedBoundary,
        accountMasterKey: accountMasterKey.get(),
        actor: recoveryActor,
        encryptionPublicKey: new Uint8Array(
          await globalThis.crypto.subtle.exportKey(
            "raw",
            keyMaterial.encryptionPublicKey,
          ),
        ),
        signingPublicKey: hexToBytes(device.signingPublicKey),
      });
      if (cancelled()) return;
      if (!boundary.session.userId)
        throw new Error("the narrowed boundary lost its session");
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
      if (cancelled()) return;
      const expectedHeadId =
        boundary.environment.headRevision === "empty-environment"
          ? null
          : boundary.environment.headRevision;
      // The service refuses a Revision authored before this Device or its
      // Membership became active; a slow clock is raised to that floor.
      const authoredAtNotBeforeMs = deviceAuthoredAtNotBeforeMs(
        boundary.signingTrustDevices ?? [],
        device.id,
      );
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
        ...(authoredAtNotBeforeMs === undefined
          ? {}
          : { authoredAtNotBeforeMs }),
      };
      // Scope the journal to the server, Environment and Device so a pending
      // publication never replays against a different server or Environment.
      const publicationKeyPrefix = `dotrelay-publication:${encodeURIComponent(profile.origin)}:${profile.serverProfileId ?? profile.id}:${environment.id}:${device.id}:`;
      const transport = createProtocolTransport({
        origin: profile.origin,
        deviceProof: browserDeviceProof({
          apiOrigin: profile.origin,
          pin,
          deviceId: device.id,
        }),
        pendingPublication: {
          read: async () => {
            const prefix = publicationKeyPrefix;
            const key = Object.keys(localStorage)
              .filter((key) => key.startsWith(prefix))
              .sort()[0];
            return key ? localStorage.getItem(key) : null;
          },
          write: async (value, operationId) => {
            const key = `${publicationKeyPrefix}${operationId}`;
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
          },
        },
      });
      // Every history signer is a roster-verified Device entry that binds a
      // Revision's author to its signing Device. Without one, this browser
      // trusts only its own key for its own User and Device (ADR 0023): a
      // plain teammate key could claim any author.
      const scopedSigningTrustDevices = revisionSigningTrustEntries(
        boundary.signingTrustDevices ?? [],
      );
      // ADR 0022: the account's own envelope wins over a grant, a grant
      // counts only from a verified signer, and every key must match what
      // this browser pinned for the Project and epoch.
      const pinStore = {
        load: () => loadBrowserAccountTrustPins(pin, device.id ?? ""),
        save: (pins: Parameters<typeof saveBrowserAccountTrustPins>[2]) =>
          saveBrowserAccountTrustPins(pin, device.id ?? "", pins),
      };
      let sharedValueSecret = await adoptProjectEpochKey({
        boundary,
        accountMasterKey: accountMasterKey.get(),
        encryptionPrivateKey: keyMaterial.encryptionPrivateKey,
        wrappers: recoveryWrappers,
        pinStore,
      });
      if (cancelled()) return;
      // A direct grant can predate recovery setup. Once the account key is
      // unlocked, seal that exact Project key for future devices; never mint
      // a replacement for an existing encrypted environment.
      const grantKeyMaster = accountMasterKey.get();
      if (
        sharedValueSecret &&
        grantKeyMaster &&
        !boundary.accountKeyEnvelope &&
        recoveryActor &&
        environment.projectId
      ) {
        try {
          const envelope = await createAccountKeyEnvelope({
            serverProfileId: profile.serverProfileId,
            userId: bundle.userId,
            deviceId: uuidToBytes(device.id),
            createdAtMs: Date.now(),
            accountMasterKey: grantKeyMaster,
            signingPrivateKey: keyMaterial.signingPrivateKey,
            kind: {
              type: "projectEpochKey",
              projectId: uuidToBytes(environment.projectId),
              projectEpoch: Number(environment.projectEpoch ?? 1),
              contentKey: sharedValueSecret,
            },
          });
          await publishAccountKeyEnvelope(
            recoveryActor,
            globalThis.crypto.randomUUID(),
            envelope,
            {
              envelopeType: "PROJECT_EPOCH_KEY",
              projectId: environment.projectId,
              projectEpoch: Number(environment.projectEpoch ?? 1),
            },
          );
        } catch {
          // Another Device may have published first. The direct grant still
          // opens this environment; a refresh will show the winning envelope.
        }
      }
      if (cancelled()) return;
      if (cancelled()) return;
      // The last-resort self-mint, mirroring the CLI: only when the
      // account key is unlocked, no Device holds this epoch's key, and
      // no peer holds one — otherwise a fresh random key could never
      // decrypt pre-existing content and would block the peer re-share.
      const selfMintKey = accountMasterKey.get();
      if (
        sharedValueSecret === undefined &&
        selfMintKey &&
        !boundary.grantsReady &&
        !(boundary.peerDevices ?? []).some((peer) => peer.hasEpochGrant) &&
        // An epoch this browser already holds a key for never gets a new one.
        !projectEpochKeyPinned(
          await pinStore.load(),
          environment.projectId,
          Number(environment.projectEpoch ?? 1),
        )
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
          await pinProjectEpochRing(pinStore, {
            serverProfileId: profile.serverProfileId,
            projectId: environment.projectId,
            currentEpoch: projectEpoch,
            ring: new Map([[projectEpoch, epochKey]]),
          });
          sharedValueSecret = epochKey;
        }
      }
      if (cancelled()) return;
      const pastEpochKeyMaster = accountMasterKey.get();
      const sharedValueKeyRing =
        sharedValueSecret &&
        environment.projectId &&
        environment.teamId &&
        profile.serverProfileId
          ? await projectEpochKeyRing({
              boundary,
              serverProfileId: profile.serverProfileId,
              teamId: environment.teamId,
              projectId: environment.projectId,
              currentEpoch: Number(environment.projectEpoch ?? 1),
              currentKey: sharedValueSecret,
              backfill:
                pastEpochKeyMaster && recoveryActor
                  ? {
                      actor: recoveryActor,
                      recoveryWrappers,
                      accountMasterKey: pastEpochKeyMaster,
                    }
                  : null,
            })
          : undefined;
      if (cancelled()) return;
      if (sharedValueKeyRing && sharedValueKeyRing.size > 0)
        await pinProjectEpochRing(pinStore, {
          serverProfileId: profile.serverProfileId,
          projectId: environment.projectId,
          currentEpoch: Number(environment.projectEpoch ?? 1),
          ring: sharedValueKeyRing,
        });
      if (cancelled()) return;
      // A grant this browser couldn't use is almost always from a teammate
      // whose fingerprint isn't confirmed here yet (ADR 0022); say so instead
      // of the generic "can't read this project" message.
      const projectKeyBlocked =
        sharedValueSecret === undefined && boundary.epochGrant
          ? ("unconfirmed-sharer" as const)
          : undefined;
      const createdSession = createEnvironmentProtocolSession({
        context: sharedValueSecret
          ? { ...context, sharedValueSecret }
          : context,
        transport,
        sharedValuePrivateKey: keyMaterial.encryptionPrivateKey,
        userDefinedValuePrivateKey: keyMaterial.encryptionPrivateKey,
        signingTrustKeys:
          scopedSigningTrustDevices.length > 0
            ? scopedSigningTrustDevices
            : ownSigningTrust(context),
        legacyLaneAuthors: boundary.verifiedSigners?.confirmedUserIds ?? [],
        ...(sharedValueSecret ? { sharedValueSecret } : {}),
        ...(sharedValueKeyRing && sharedValueKeyRing.size > 0
          ? { sharedValueKeyRing }
          : {}),
        ...(userDefinedValueSecret ? { userDefinedValueSecret } : {}),
      });
      const session = projectKeyBlocked
        ? { ...createdSession, projectKeyBlocked }
        : createdSession;
      if (cancelled()) return;
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
      if (!cancelled()) setTrustProblem?.(null);
      settleContext();
    } catch (error) {
      const problem = trustProblemMessage(error);
      if (problem && !cancelled()) setTrustProblem?.(problem);
      clearSelectedSession();
      if (boundaryMatchesSelection) settleContext();
    }
  };
  return loadSession();
};
