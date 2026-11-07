import { readFile, rm } from "node:fs/promises";
import {
  createProjectEpochGrantBootstrap,
  openProjectEpochKeyLink,
  readProjectEpochKeyLinkEpochs,
} from "@dotrelay/client";
import { open, seal, sha384 } from "@dotrelay/contracts";
import { CliError } from "./errors";
import { atomicWriteProtectedFile } from "./output";
import {
  base64,
  type Boundary,
  createDeviceAdmin,
  fromBase64,
  safeProjectEpoch,
  type WorkflowOptions,
} from "./workflow-core";

// A rotation generates the new Project Epoch Key before it is committed and
// seals the previous key under it in the Project Epoch Key Link (ADR 0014).
// If the commit's outcome is unknown, losing the new key would strand the
// Project at an epoch nobody can read. So the key is kept, sealed to this
// Device's X25519 key, until the outcome is settled: either the served link
// for the new epoch opens with it (the rotation committed) or the Project
// never reached that epoch.

type PendingRotation = Readonly<{
  version: 1;
  operationId: string;
  projectId: string;
  newEpoch: number;
  sealedKey: string;
}>;

const associatedData = (projectId: string, newEpoch: number) =>
  new TextEncoder().encode(
    `dotrelay-pending-rotation-v1\0${projectId}\0${newEpoch}`,
  );

export const pendingRotationPath = (
  options: WorkflowOptions,
  projectId: string,
): string =>
  `${options.stateDirectory}/pending-rotation-${options.profile.pin.serverProfileId}-${projectId}.json`;

export const writePendingRotation = async (
  options: WorkflowOptions,
  input: Readonly<{
    operationId: string;
    projectId: string;
    newEpoch: number;
    newEpochKey: Uint8Array;
    encryptionPublicKey: CryptoKey;
  }>,
): Promise<void> => {
  const sealed = await seal(
    input.newEpochKey,
    input.encryptionPublicKey,
    associatedData(input.projectId, input.newEpoch),
  );
  const record: PendingRotation = {
    version: 1,
    operationId: input.operationId,
    projectId: input.projectId,
    newEpoch: input.newEpoch,
    sealedKey: base64(sealed),
  };
  await atomicWriteProtectedFile(
    pendingRotationPath(options, input.projectId),
    `${JSON.stringify(record)}\n`,
  );
};

export const clearPendingRotation = (
  options: WorkflowOptions,
  projectId: string,
): Promise<void> =>
  rm(pendingRotationPath(options, projectId), { force: true });

const readPendingRotation = async (
  options: WorkflowOptions,
  projectId: string,
): Promise<PendingRotation | null> => {
  try {
    const value = JSON.parse(
      await readFile(pendingRotationPath(options, projectId), "utf8"),
    ) as PendingRotation;
    return value.version === 1 &&
      value.projectId === projectId &&
      Number.isSafeInteger(value.newEpoch) &&
      typeof value.sealedKey === "string"
      ? value
      : null;
  } catch {
    return null;
  }
};

export const PENDING_ROTATION_NOTICE =
  "An earlier project rotation's outcome is still unknown; its new key is kept sealed to this device. Run dotrelay pull again once the Server Profile can confirm it, before rotating again";

// A new rotation must not start while an earlier one may still commit: it
// would overwrite or delete the only copy of that rotation's new key.
export const assertNoPendingRotation = async (
  options: WorkflowOptions,
  projectId: string,
): Promise<void> => {
  if (await readPendingRotation(options, projectId))
    throw new CliError(
      "conflict",
      "an earlier rotation of this project has an unknown outcome and its new key is kept on this device. Run dotrelay pull once the Server Profile is reachable, then rotate again if you still need to",
      {},
      "epoch_rotation_uncertain",
    );
};

export const hasPendingRotation = async (
  options: WorkflowOptions,
  projectId: string,
): Promise<boolean> => (await readPendingRotation(options, projectId)) !== null;

// Cancels the rotation's operation. A cancelled operation can never be begun
// again, so true means the rotation is confirmed unable to commit; false
// (already committed, or no answer) leaves the outcome open.
export type CancelRotation = (operationId: string) => Promise<boolean>;

export class RotationOutcomeUnknownError extends Error {
  constructor() {
    super("the rotation's outcome is unknown");
    this.name = "RotationOutcomeUnknownError";
  }
}

// Submits the epoch transition. Any failure is replayed once with the same
// operation, which returns a committed outcome idempotently. The sealed key
// is discarded only after a successful cancel proves the operation cannot
// commit; otherwise it is kept and RotationOutcomeUnknownError is thrown.
// A failure's status code is not trusted for this: a 429, for example, can
// arrive before the service checks whether the first attempt committed.
export const submitRotation = async <T>(
  input: Readonly<{
    attempt: () => Promise<T>;
    cancel: () => Promise<boolean>;
    discardPending: () => Promise<void>;
  }>,
): Promise<T> => {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await input.attempt();
    } catch (error) {
      failure = error;
    }
  }
  if (await input.cancel()) {
    await input.discardPending();
    throw failure;
  }
  throw new RotationOutcomeUnknownError();
};

// Settles a pending rotation against the boundary. Returns the new epoch key
// when the Project is at that epoch and its served link opens with the key,
// which proves this Device's rotation committed. The record is discarded only
// when the rotation provably cannot commit: another rotation took the epoch,
// or the Project is still behind it and cancelling the operation succeeded.
export const resolvePendingRotation = async (
  input: Readonly<{
    options: WorkflowOptions;
    boundary: Boundary;
    encryptionPrivateKey: CryptoKey;
    trustedSigningKeys: readonly Uint8Array[];
    cancel: CancelRotation;
  }>,
): Promise<Uint8Array | null> => {
  const { projectId, teamId } = input.boundary.environment;
  if (!projectId || !teamId) return null;
  const pending = await readPendingRotation(input.options, projectId);
  if (!pending) return null;
  const currentEpoch = safeProjectEpoch(
    input.boundary.environment.projectEpoch,
  );
  if (currentEpoch < pending.newEpoch) {
    // The request may still be in flight; only a cancel settles it.
    if (await input.cancel(pending.operationId))
      await clearPendingRotation(input.options, projectId);
    return null;
  }
  if (currentEpoch > pending.newEpoch) {
    // Whichever rotation reached that epoch, its successor's link carries
    // the key; a staged operation for an older epoch can no longer commit.
    await clearPendingRotation(input.options, projectId);
    return null;
  }
  let key: Uint8Array;
  try {
    key = await open(
      fromBase64(pending.sealedKey, "pending rotation key"),
      input.encryptionPrivateKey,
      associatedData(projectId, pending.newEpoch),
    );
  } catch {
    await clearPendingRotation(input.options, projectId);
    return null;
  }
  for (const encoded of input.boundary.epochKeyLinks) {
    try {
      const bytes = fromBase64(encoded, "Project epoch key link");
      if (readProjectEpochKeyLinkEpochs(bytes)?.toEpoch !== pending.newEpoch)
        continue;
      await openProjectEpochKeyLink(bytes, {
        serverProfileId: input.options.profile.pin.serverProfileId,
        teamId,
        projectId,
        toEpoch: pending.newEpoch,
        toKey: key,
        trustedSigningKeys: input.trustedSigningKeys,
      });
      return key;
    } catch {
      // Not this rotation's link.
    }
  }
  key.fill(0);
  await clearPendingRotation(input.options, projectId);
  return null;
};

// A Device without the AMK keeps a recovered key only through a grant to
// itself; with the AMK the session publishes the Account Key Envelope.
export const grantRecoveredKeyToSelf = async (
  input: Readonly<{
    options: WorkflowOptions;
    boundary: Boundary;
    deviceId: string;
    encryptionPublicKey: CryptoKey;
    signingPrivateKey: CryptoKey;
    epochKey: Uint8Array;
  }>,
): Promise<void> => {
  const { projectId, teamId } = input.boundary.environment;
  if (!projectId || !teamId) return;
  const recipientX25519PublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", input.encryptionPublicKey),
  );
  const grant = await createProjectEpochGrantBootstrap({
    serverProfileId: input.options.profile.pin.serverProfileId,
    teamId,
    projectId,
    projectEpoch: safeProjectEpoch(input.boundary.environment.projectEpoch),
    senderDeviceId: input.deviceId,
    recipientDeviceId: input.deviceId,
    recipientX25519PublicKey,
    recipientEncryptionPublicKey: input.encryptionPublicKey,
    signingPrivateKey: input.signingPrivateKey,
    plaintextKey: input.epochKey,
  });
  const operationId = crypto.randomUUID();
  await createDeviceAdmin(input.options, input.deviceId).post(
    "/api/v1/grants/bootstrap",
    {
      operationId,
      teamId,
      projectId,
      objectId: grant.objectId,
      digest: base64(await sha384(grant.canonicalBytes)),
      grant: base64(grant.canonicalBytes),
    },
    ["grantObjectId", "idempotent"],
    { idempotencyKey: operationId },
  );
};
