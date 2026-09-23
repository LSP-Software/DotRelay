import {
  createBrowserDeviceStorage,
  createDeviceBootstrap,
  createProjectEpochGrantBootstrap,
  type DeviceBootstrap,
  type DeviceKeyMaterial,
  loadDeviceKeyMaterial,
  probeBrowserDeviceStorage,
  uuidToBytes,
} from "@dotrelay/client";
import type { Dispatch, SetStateAction } from "react";
import { bytesToHex } from "@/lib/account-keys";
import {
  probeBrowserLocalStorage,
  readStoredBrowserDeviceId,
  writeStoredBrowserDeviceId,
} from "@/lib/browser-storage";
import {
  fetchWorkspaceBoundary,
  type WorkspaceBoundary,
  type WorkspaceProfileId,
} from "@/lib/workspace-boundary";

// Browser Device provisioning and stale-epoch repair: the two flows by
// which this browser (re)gains the keys it needs to read a project's
// values.
//
// Provisioning creates a Device on the Server Profile, persists its keys
// to this machine, and seeds the project's epoch grant when no other
// Device holds the key. A retry replays the pending bootstrap and
// operation identity, so it cannot create a duplicate remote Device.
//
// The stale-epoch repair reuses what this browser already holds before it
// proposes a Device replacement. It re-verifies the boundary first: the
// current grant may have been provisioned in the meantime by another of
// the User's Devices or by a CLI run. If the keys are still missing, the
// stored Device keys sign a fresh grant for the current epoch, which
// discards nothing local. Only when the stored keys are unusable, or the
// service deactivated the Device, is a replacement Device proposed, and
// that discards the browser's stored keys, so it asks for approval first.

// A Device bootstrap awaiting completion: the local keys and the
// operation identity an earlier attempt committed, retained so a retry
// replays the same bootstrap instead of duplicating the remote Device.
export type PendingEnrollment = Readonly<{
  readonly bootstrap: DeviceBootstrap;
  readonly operationId: string;
}>;

export type DeviceProvisioningContext = Readonly<{
  readonly apiOrigin: string;
  readonly profileId: WorkspaceProfileId;
  readonly boundary: WorkspaceBoundary;
  readonly selectedProjectId: string | null;
  readonly selectedTeamId: string | null;
  readonly selectedTeamName: string | null;
  readonly selectedEnvironmentId: string | null;
  readonly environmentId: string | null;
  readonly pendingEnrollment: Readonly<{
    readonly get: (key: string) => PendingEnrollment | undefined;
    readonly set: (key: string, value: PendingEnrollment) => void;
    readonly delete: (key: string) => void;
  }>;
  readonly durableBrowserDevice: Readonly<{
    readonly add: (key: string) => void;
  }>;
  readonly onMessage: Dispatch<SetStateAction<string | null>>;
  readonly onInProgress: (inProgress: boolean) => void;
  readonly onCommit: (boundary: WorkspaceBoundary) => void;
  readonly onOffline: () => void;
}>;

const toBase64 = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const provisionBrowserDevice = async (
  ctx: DeviceProvisioningContext,
): Promise<void> => {
  const { apiOrigin, profileId, boundary } = ctx;
  const { onMessage, onInProgress, onCommit, onOffline } = ctx;
  if (!boundary.session.userId || !boundary.profile.serverProfileId) {
    onMessage("Sign in before setting up this browser.");
    return;
  }
  const pin = {
    serverProfileId: boundary.profile.serverProfileId,
    origin: boundary.profile.origin,
  };
  const pinKey = `${pin.origin}\u0000${pin.serverProfileId}`;
  onInProgress(true);
  onMessage(null);
  try {
    // Preflight durable storage before creating a Device on the Server
    // Profile: with only a memory fallback or blocked local storage the
    // keys could not survive a reload, so no Device is created at all.
    const recordsProbe = await probeBrowserDeviceStorage();
    if (!recordsProbe.durable) {
      onMessage(
        "This browser can't save keys in persistent storage. Reloading would lose them, so we haven't set this browser up. Allow site storage, then try again.",
      );
      return;
    }
    if (!probeBrowserLocalStorage()) {
      onMessage(
        "This browser blocks local storage and can't remember its device ID after a reload. We haven't set it up. Allow local storage, then try again.",
      );
      return;
    }
    // Reuse the pending keys and operation identity from an earlier
    // attempt so a retry replays the same bootstrap instead of creating a
    // duplicate remote Device.
    const pending = ctx.pendingEnrollment.get(pinKey);
    const bootstrap =
      pending?.bootstrap ??
      (await createDeviceBootstrap({
        pin,
        userId: boundary.session.userId,
      }));
    const operationId = pending?.operationId ?? globalThis.crypto.randomUUID();
    if (!pending)
      ctx.pendingEnrollment.set(
        pinKey,
        Object.freeze({ bootstrap, operationId }),
      );
    const response = await fetch(`${apiOrigin}/api/v1/devices/bootstrap`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId,
        deviceId: bootstrap.deviceId,
        identityGeneration: bootstrap.identityGeneration,
        keyId: bytesToHex(bootstrap.keyId),
        x25519PublicKey: bytesToHex(bootstrap.x25519PublicKey),
        ed25519PublicKey: bytesToHex(bootstrap.ed25519PublicKey),
        certificateId: bootstrap.certificate.id,
        certificate: toBase64(bootstrap.certificate.canonicalBytes),
      }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        readonly code?: unknown;
      } | null;
      if (body?.code === "authentication_required")
        throw new Error("Sign in before setting up this browser.");
      if (body?.code === "state_conflict")
        throw new Error("We couldn't set up this browser. Try again.");
      throw new Error("The server rejected this browser.");
    }
    const persistDeviceLocally = async (): Promise<
      "complete" | "records" | "device-id"
    > => {
      try {
        await createBrowserDeviceStorage(pin).save(bootstrap.bundle);
      } catch {
        return "records";
      }
      try {
        writeStoredBrowserDeviceId(
          pin.origin,
          pin.serverProfileId,
          bootstrap.deviceId,
        );
      } catch {
        return "device-id";
      }
      // Verify from a fresh storage instance that a reload could recover
      // the bundle before durable enrollment is claimed.
      try {
        const verifyStorage = createBrowserDeviceStorage(pin);
        await verifyStorage.load({
          pin,
          deviceId: uuidToBytes(bootstrap.deviceId),
        });
      } catch {
        return "records";
      }
      return readStoredBrowserDeviceId(pin.origin, pin.serverProfileId) ===
        bootstrap.deviceId
        ? "complete"
        : "device-id";
    };
    const persistence = await persistDeviceLocally();
    if (persistence === "complete") {
      ctx.pendingEnrollment.delete(pinKey);
      ctx.durableBrowserDevice.add(pinKey);
      const environment = {
        projectId: ctx.selectedProjectId ?? boundary.environment.projectId,
        teamId: ctx.selectedTeamId ?? boundary.environment.teamId,
        projectEpoch: boundary.environment.projectEpoch,
      };
      const otherDeviceExists =
        Boolean(boundary.device.active) &&
        boundary.device.id !== bootstrap.deviceId;
      // A peer that already holds the current epoch grant owns the real key;
      // self-minting here would seal this Device to a fresh random key that
      // can never decrypt pre-existing content and would permanently block a
      // peer re-share, so the grant must be handed over by a Device that
      // holds the key (or recovered with the account's recovery code).
      const peerHoldsEpochKey = (boundary.peerDevices ?? []).some(
        (peer) => peer.hasEpochGrant,
      );
      if (
        !otherDeviceExists &&
        !peerHoldsEpochKey &&
        environment.projectId &&
        environment.teamId &&
        environment.projectEpoch &&
        bootstrap.keyMaterial.encryptionPublicKey
      ) {
        const grant = await createProjectEpochGrantBootstrap({
          serverProfileId: boundary.profile.serverProfileId,
          teamId: environment.teamId,
          projectId: environment.projectId,
          projectEpoch: Number(environment.projectEpoch),
          senderDeviceId: bootstrap.deviceId,
          recipientDeviceId: bootstrap.deviceId,
          recipientX25519PublicKey: bootstrap.x25519PublicKey,
          recipientEncryptionPublicKey:
            bootstrap.keyMaterial.encryptionPublicKey,
          signingPrivateKey: bootstrap.keyMaterial.signingPrivateKey,
        });
        const grantResponse = await fetch(
          `${apiOrigin}/api/v1/grants/bootstrap`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "X-DotRelay-Device-Id": bootstrap.deviceId,
            },
            body: JSON.stringify({
              operationId: globalThis.crypto.randomUUID(),
              objectId: grant.objectId,
              projectId: environment.projectId,
              teamId: environment.teamId,
              digest: toBase64(grant.digest),
              grant: toBase64(grant.canonicalBytes),
            }),
          },
        );
        if (!grantResponse.ok)
          onMessage(
            "This browser is set up. Access to this project's secrets is still pending.",
          );
      }
    }
    const nextBoundary = await fetchWorkspaceBoundary(profileId, {
      deviceId: bootstrap.deviceId,
      ...(ctx.selectedEnvironmentId
        ? { environmentId: ctx.selectedEnvironmentId }
        : ctx.environmentId
          ? { environmentId: ctx.environmentId }
          : {}),
    });
    if (nextBoundary.connection === "online") {
      onCommit(nextBoundary);
    } else {
      onOffline();
    }
    if (persistence === "complete") {
      onMessage((current) =>
        current?.includes("pending")
          ? current
          : "This browser is set up. Its private keys stay on this machine.",
      );
    } else if (persistence === "records") {
      onMessage(
        "The server set this browser up, but the browser couldn't save its keys. Access won't survive a reload. Retry setup to save the keys.",
      );
    } else {
      onMessage(
        "The server set this browser up, but the browser couldn't save its device ID. Access won't survive a reload. Retry setup to save the ID.",
      );
    }
  } catch (error) {
    onMessage(
      error instanceof Error
        ? error.message
        : "We couldn't finish setting up this browser.",
    );
  } finally {
    onInProgress(false);
  }
};

export const recoveredProjectAccess = (candidate: WorkspaceBoundary): boolean =>
  candidate.device.active && candidate.grantsReady && candidate.epochCurrent;

export type DeviceRepairContext = Readonly<{
  readonly apiOrigin: string;
  readonly profileId: WorkspaceProfileId;
  readonly boundary: WorkspaceBoundary;
  readonly selectedEnvironmentId: string | null;
  readonly environmentId: string | null;
  readonly selectedTeamName: string | null;
  readonly onMessage: Dispatch<SetStateAction<string | null>>;
  readonly onInProgress: (inProgress: boolean) => void;
  readonly onCommit: (boundary: WorkspaceBoundary) => void;
  readonly onOffline: () => void;
  readonly onReplacementNeeded: () => void;
}>;

export const repairStaleEpoch = async (
  ctx: DeviceRepairContext,
): Promise<void> => {
  const { apiOrigin, profileId, boundary } = ctx;
  const { onMessage, onInProgress, onCommit, onOffline } = ctx;
  const profile = boundary.profile;
  const device = boundary.device;
  if (!boundary.session.userId) {
    onMessage("Sign in before restoring this browser's keys.");
    return;
  }
  if (!profile.serverProfileId || !device.active || !device.id) {
    ctx.onReplacementNeeded();
    return;
  }
  const pin = {
    serverProfileId: profile.serverProfileId,
    origin: profile.origin,
  };
  onInProgress(true);
  onMessage(null);
  try {
    const storedId = readStoredBrowserDeviceId(pin.origin, pin.serverProfileId);
    const nextBoundary = await fetchWorkspaceBoundary(profileId, {
      ...(storedId ? { deviceId: storedId } : {}),
      ...(ctx.selectedEnvironmentId
        ? { environmentId: ctx.selectedEnvironmentId }
        : ctx.environmentId
          ? { environmentId: ctx.environmentId }
          : {}),
    });
    if (nextBoundary.connection !== "online") {
      onOffline();
      onMessage(
        "Couldn't reach the server, so the keys couldn't be restored. Try again.",
      );
      return;
    }
    onCommit(nextBoundary);
    if (recoveredProjectAccess(nextBoundary)) {
      // The unblocked editor is the result report: nothing needs saying.
      return;
    }
    // The stored Device keys sign the fresh grant; a mismatch between the
    // stored public key and the service's record means these keys belong
    // to a different Device and cannot be used.
    let keyMaterial: DeviceKeyMaterial | null = null;
    let x25519PublicKey: Uint8Array | null = null;
    if (storedId === device.id && device.encryptionPublicKey) {
      try {
        const storage = createBrowserDeviceStorage(pin);
        const bundle = await storage.load({
          pin,
          deviceId: uuidToBytes(device.id),
        });
        const material = await loadDeviceKeyMaterial(bundle);
        if (material.encryptionPublicKey) {
          const exported = new Uint8Array(
            await globalThis.crypto.subtle.exportKey(
              "raw",
              material.encryptionPublicKey,
            ),
          );
          if (bytesToHex(exported) === device.encryptionPublicKey) {
            keyMaterial = material;
            x25519PublicKey = exported;
          }
        }
      } catch {
        keyMaterial = null;
      }
    }
    const teamId = nextBoundary.environment.teamId ?? null;
    const projectId = nextBoundary.environment.projectId ?? null;
    const projectEpoch = Number(nextBoundary.environment.projectEpoch);
    if (
      keyMaterial?.encryptionPublicKey &&
      x25519PublicKey &&
      teamId &&
      projectId &&
      Number.isSafeInteger(projectEpoch) &&
      projectEpoch >= 1
    ) {
      const grant = await createProjectEpochGrantBootstrap({
        serverProfileId: profile.serverProfileId,
        teamId,
        projectId,
        projectEpoch,
        senderDeviceId: device.id,
        recipientDeviceId: device.id,
        recipientX25519PublicKey: x25519PublicKey,
        recipientEncryptionPublicKey: keyMaterial.encryptionPublicKey,
        signingPrivateKey: keyMaterial.signingPrivateKey,
      });
      const response = await fetch(`${apiOrigin}/api/v1/grants/bootstrap`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-DotRelay-Device-Id": device.id,
        },
        body: JSON.stringify({
          operationId: globalThis.crypto.randomUUID(),
          objectId: grant.objectId,
          projectId,
          teamId,
          digest: toBase64(grant.digest),
          grant: toBase64(grant.canonicalBytes),
        }),
      });
      if (response.ok) {
        const refreshed = await fetchWorkspaceBoundary(profileId, {
          deviceId: device.id,
          ...(ctx.selectedEnvironmentId
            ? { environmentId: ctx.selectedEnvironmentId }
            : ctx.environmentId
              ? { environmentId: ctx.environmentId }
              : {}),
        });
        if (refreshed.connection === "online") onCommit(refreshed);
        else onOffline();
        onMessage(
          recoveredProjectAccess(refreshed)
            ? null
            : "The server accepted the new keys, but project access is still pending. Try again.",
        );
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        readonly code?: unknown;
      } | null;
      const code = typeof body?.code === "string" ? body.code : null;
      if (code === "device_not_active") {
        // The service deactivated the Device, so its keys can no longer
        // sign; only a replacement Device recovers this browser.
        ctx.onReplacementNeeded();
        return;
      }
      if (code === "stale_epoch") {
        onMessage(
          "Key rotation is still in progress on this project. Wait for it to finish, then try again.",
        );
        return;
      }
      const teamName =
        nextBoundary.catalog.teams.find((team) => team.id === teamId)?.name ??
        ctx.selectedTeamName ??
        "your team";
      onMessage(
        `This browser can't recover the project's current keys on its own. Recover the account's key from the Recovery area, or have another of your devices run \`dotrelay device transfer\` to hand this browser the key${teamName !== "your team" ? `; ${teamName}'s Owners and Admins can also rotate the project's keys` : ""}.`,
      );
      return;
    }
    // No usable local keys for this Device: the only repair is a
    // replacement Device, which discards the browser's stored keys.
    ctx.onReplacementNeeded();
  } catch {
    onMessage("Couldn't restore the project's keys. Try again.");
  } finally {
    onInProgress(false);
  }
};
