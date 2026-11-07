import {
  mkdir,
  open as openFile,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  createProjectEpochGrantBootstrap,
  openProjectEpochKeyLink,
  readProjectEpochKeyLinkEpochs,
} from "@dotrelay/client";
import { open, seal, sha384 } from "@dotrelay/contracts";
import { CliError } from "./errors";
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

// Each rotation keeps its own record, named by its operation id. Removing a
// record therefore never needs a read-then-delete ownership check: a run can
// only ever delete the file it created.
const recordPrefix = (options: WorkflowOptions, projectId: string): string =>
  `pending-rotation-${options.profile.pin.serverProfileId}-${projectId}.`;

export const pendingRotationPath = (
  options: WorkflowOptions,
  projectId: string,
  operationId: string,
): string =>
  `${options.stateDirectory}/${recordPrefix(options, projectId)}${operationId}.json`;

// Every pending record of the Project, oldest operation id first.
export const listPendingRotationPaths = async (
  options: WorkflowOptions,
  projectId: string,
): Promise<string[]> => {
  const prefix = recordPrefix(options, projectId);
  try {
    return (await readdir(options.stateDirectory))
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .sort()
      .map((name) => `${options.stateDirectory}/${name}`);
  } catch {
    return [];
  }
};

export class PendingRotationExistsError extends CliError {
  constructor() {
    super(
      "conflict",
      "another rotation of this project is in progress or has an unknown outcome on this device. Run dotrelay pull, then rotate again if you still need to",
      {},
      "epoch_rotation_uncertain",
    );
  }
}

// Reserves the Project for this rotation: write this operation's own record
// (exclusive create of a unique name), then abort if any other record of the
// Project exists. Two concurrent runs can both abort, never both proceed, and
// neither touches the other's record.
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
  const path = pendingRotationPath(options, input.projectId, input.operationId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await openFile(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const others = (
    await listPendingRotationPaths(options, input.projectId)
  ).filter((candidate) => candidate !== path);
  if (others.length > 0) {
    await rm(path, { force: true });
    throw new PendingRotationExistsError();
  }
};

// Removes this operation's own record; it cannot reach another rotation's.
export const clearPendingRotation = (
  options: WorkflowOptions,
  projectId: string,
  operationId: string,
): Promise<void> =>
  rm(pendingRotationPath(options, projectId, operationId), { force: true });

const readRecord = async (
  path: string,
  projectId: string,
): Promise<PendingRotation | null> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as PendingRotation;
    return value.version === 1 &&
      value.projectId === projectId &&
      typeof value.operationId === "string" &&
      path.endsWith(`.${value.operationId}.json`) &&
      Number.isSafeInteger(value.newEpoch) &&
      typeof value.sealedKey === "string"
      ? value
      : null;
  } catch {
    return null;
  }
};

const readPendingRotation = async (
  options: WorkflowOptions,
  projectId: string,
): Promise<PendingRotation | null> => {
  for (const path of await listPendingRotationPaths(options, projectId)) {
    const record = await readRecord(path, projectId);
    if (record) return record;
  }
  return null;
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
): Promise<Readonly<{ key: Uint8Array; operationId: string }> | null> => {
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
      await clearPendingRotation(input.options, projectId, pending.operationId);
    return null;
  }
  if (currentEpoch > pending.newEpoch) {
    // Whichever rotation reached that epoch, its successor's link carries
    // the key; a staged operation for an older epoch can no longer commit.
    await clearPendingRotation(input.options, projectId, pending.operationId);
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
    await clearPendingRotation(input.options, projectId, pending.operationId);
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
      return { key, operationId: pending.operationId };
    } catch {
      // Not this rotation's link.
    }
  }
  key.fill(0);
  await clearPendingRotation(input.options, projectId, pending.operationId);
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
