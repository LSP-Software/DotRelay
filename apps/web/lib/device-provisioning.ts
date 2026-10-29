import {
  createBrowserDeviceStorage,
  createDeviceBootstrap,
  createDeviceEnrollmentRequest,
  createProjectEpochGrantBootstrap,
  type DeviceBootstrap,
  type DeviceKeyMaterial,
  loadDeviceKeyMaterial,
  probeBrowserDeviceStorage,
  uuidToBytes,
} from "@dotrelay/client";
import { sha384 } from "@dotrelay/contracts";
import type { Dispatch, SetStateAction } from "react";
import { bytesToHex } from "@/lib/account-keys";
import {
  probeBrowserLocalStorage,
  readStoredBrowserDeviceId,
  writeStoredBrowserDeviceId,
} from "@/lib/browser-storage";
import { describeThisBrowser } from "@/lib/device-describe";
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
// When the bootstrap is rejected because the User already has a Device, the
// same local keys start a Device enrollment instead; the enrollment's
// expiry is retained so a retry replays that enrollment too.
export type PendingEnrollment = Readonly<{
  readonly bootstrap: DeviceBootstrap;
  readonly operationId: string;
  readonly enrollmentExpiresAtMs?: number;
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

// A user-facing provisioning failure: its message is shown verbatim on the
// Devices card. Anything else that escapes the flow is unexpected, so it is
// reported with a neutral retry message instead of leaking raw browser or
// server text.
class ProvisioningMessage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisioningMessage";
  }
}

// Every problem code the server's devices/bootstrap route can return,
// mapped to what the person at this browser can do about it. Codes the
// route cannot return fall through to the neutral retry message.
export const bootstrapFailureMessage = (code: string | null): string => {
  switch (code) {
    case "authentication_required":
      return "Sign in before setting up this browser.";
    case "state_conflict":
      return "We couldn't set up this browser. Try again.";
    case "service_unavailable":
      return "The server couldn't finish setting up this browser right now. Try again in a moment.";
    case "rate_limited":
      return "The server is limiting requests from this browser right now. Wait a moment, then try again.";
    case "device_not_active":
      return "This browser's device is no longer active on the server. It may have been revoked; check the Devices list, then try again.";
    case "unsupported_api_version":
    case "unsupported_crypto_suite":
    case "unsupported_crypto_runtime":
      return "This server uses an API or cryptography this browser can't use. Try a current version of your browser.";
    case "invalid_request":
    case "invalid_crypto_object":
      return "The server didn't accept this browser's setup. Try again; if it keeps happening, this browser may not be compatible with the server.";
    default:
      return "We couldn't set up this browser. Try again; if it keeps failing, the server or your connection may be the problem.";
  }
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
    // True once the setup went through a Device enrollment instead of the
    // first-Device bootstrap: the Device is only pending until an existing
    // Device approves it, so no epoch grant can be seeded yet.
    let viaEnrollment = false;
    let response: Response;
    try {
      response = await fetch(`${apiOrigin}/api/v1/devices/bootstrap`, {
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
          client: (() => {
            const info = describeThisBrowser();
            return {
              displayName: info.displayName,
              clientKind: info.clientKind,
              ...(info.osName ? { osName: info.osName } : {}),
              ...(info.clientSummary
                ? { clientSummary: info.clientSummary }
                : {}),
            };
          })(),
        }),
      });
    } catch {
      throw new ProvisioningMessage(
        "We couldn't reach the server. Check your connection and try again.",
      );
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        readonly code?: unknown;
      } | null;
      const code = typeof body?.code === "string" ? body.code : null;
      if (code !== "state_conflict")
        throw new ProvisioningMessage(bootstrapFailureMessage(code));
      // Bootstrap creates the User's first Device only. When the User
      // already has an active Device, this browser joins through an
      // enrollment: its own keys start a self-signed request that one of
      // the User's existing Devices approves.
      await beginBrowserDeviceEnrollment(
        ctx,
        pin,
        pinKey,
        bootstrap,
        operationId,
      );
      viaEnrollment = true;
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
        !viaEnrollment &&
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
    if (viaEnrollment) {
      if (persistence === "complete") {
        onMessage((current) =>
          current?.includes("pending")
            ? current
            : "This browser is ready to join this account. Approve its enrollment on one of your other devices, then reload this page.",
        );
      } else if (persistence === "records") {
        onMessage(
          "The server started this browser's enrollment, but the browser couldn't save its keys. Access won't survive a reload. Retry setup to save the keys.",
        );
      } else {
        onMessage(
          "The server started this browser's enrollment, but the browser couldn't save its device ID. Access won't survive a reload. Retry setup to save the ID.",
        );
      }
    } else if (persistence === "complete") {
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
      error instanceof ProvisioningMessage
        ? error.message
        : "We couldn't finish setting up this browser. Try again.",
    );
  } finally {
    onInProgress(false);
  }
};

// Starts the bootstrap's keys as a self-signed Device enrollment request.
// The request's expiry is kept in the pending enrollment so an in-page
// retry replays the same enrollment instead of starting a duplicate one.
const beginBrowserDeviceEnrollment = async (
  ctx: DeviceProvisioningContext,
  pin: Readonly<{
    readonly serverProfileId: string;
    readonly origin: string;
  }>,
  pinKey: string,
  bootstrap: DeviceBootstrap,
  operationId: string,
): Promise<void> => {
  const { apiOrigin } = ctx;
  const { keyMaterial } = bootstrap;
  const userId = ctx.boundary.session.userId;
  if (!userId)
    throw new ProvisioningMessage("Sign in before setting up this browser.");
  if (!keyMaterial.encryptionPublicKey || !keyMaterial.signingPublicKey)
    throw new ProvisioningMessage(
      "This browser can't prepare its enrollment request. Try again.",
    );
  const pending = ctx.pendingEnrollment.get(pinKey);
  const enrollmentExpiresAtMs =
    pending?.enrollmentExpiresAtMs ?? Date.now() + 10 * 60 * 1000;
  if (pending?.enrollmentExpiresAtMs === undefined)
    ctx.pendingEnrollment.set(
      pinKey,
      Object.freeze({
        bootstrap,
        operationId,
        enrollmentExpiresAtMs,
      }),
    );
  const request = await createDeviceEnrollmentRequest({
    serverProfileId: pin.serverProfileId,
    origin: pin.origin,
    userId,
    identityGeneration: bootstrap.identityGeneration,
    initiatorDeviceId: bootstrap.deviceId,
    initiatorSigningPrivateKey: keyMaterial.signingPrivateKey,
    initiatorSigningPublicKey: new Uint8Array(
      await globalThis.crypto.subtle.exportKey(
        "raw",
        keyMaterial.signingPublicKey,
      ),
    ).slice(0, 32),
    expiresAtMs: enrollmentExpiresAtMs,
    deviceId: bootstrap.deviceId,
    keyMaterial: {
      encryptionPrivateKey: keyMaterial.encryptionPrivateKey,
      signingPrivateKey: keyMaterial.signingPrivateKey,
      encryptionPublicKey: keyMaterial.encryptionPublicKey,
      signingPublicKey: keyMaterial.signingPublicKey,
    },
  });
  let response: Response;
  try {
    response = await fetch(`${apiOrigin}/api/v1/devices/enrollments`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": operationId,
      },
      body: JSON.stringify({
        operationId,
        enrollmentId: request.ids.enrollmentId,
        userId,
        transcriptHash: bytesToHex(request.transcriptHash),
        challengeHash: bytesToHex(await sha384(request.challenge)),
        expiresAt: new Date(request.expiresAtMs).toISOString(),
        deviceId: request.ids.deviceId,
        identityGeneration: String(bootstrap.identityGeneration),
        x25519PublicKey: toBase64(bootstrap.x25519PublicKey),
        ed25519PublicKey: toBase64(bootstrap.ed25519PublicKey),
        keyId: toBase64(bootstrap.keyId),
        certificateObjectId: globalThis.crypto.randomUUID(),
        certificateObject: toBase64(request.certificateBytes),
        client: (() => {
          const info = describeThisBrowser();
          return {
            displayName: info.displayName,
            clientKind: info.clientKind,
            ...(info.osName ? { osName: info.osName } : {}),
            ...(info.clientSummary
              ? { clientSummary: info.clientSummary }
              : {}),
          };
        })(),
      }),
    });
  } catch {
    throw new ProvisioningMessage(
      "We couldn't reach the server. Check your connection and try again.",
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      readonly code?: unknown;
    } | null;
    const code = typeof body?.code === "string" ? body.code : null;
    throw new ProvisioningMessage(bootstrapFailureMessage(code));
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
  const { profileId, boundary } = ctx;
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
    // Missing current keys must be recovered, never replaced by a random key
    // under the existing epoch. A grant count proves presence, not correctness.
    onMessage(
      "Recover the existing project key from the Recovery area, or ask an owner or admin to share project keys. Repair cannot create a replacement key for an existing project epoch.",
    );
  } catch {
    onMessage("Couldn't restore the project's keys. Try again.");
  } finally {
    onInProgress(false);
  }
};
