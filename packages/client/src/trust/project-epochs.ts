import { sha384, uuidToBytes } from "@dotrelay/contracts";
import type { AccountTrustPins, ProjectEpochPin } from "./account-trust";

// Per-installation pins for each Project (ADR 0022): the highest Project
// epoch this installation accepted, and a commitment to the Project Epoch Key
// it adopted for each epoch. The service decides which epoch to report and
// which grant or envelope to serve; these pins stop it from moving a client
// back to an epoch it already left, or swapping the key of an epoch the
// client already holds. Commitments are local only and never sent.

const COMMITMENT_DOMAIN = new TextEncoder().encode(
  "DotRelay\0dotrelay-e2ee-v3-classical-webcrypto\0Project-epoch-key-commitment\0v1\0",
);

export class ProjectEpochTrustError extends Error {
  readonly code: "epoch-rollback" | "key-mismatch";

  constructor(code: "epoch-rollback" | "key-mismatch") {
    super(
      code === "epoch-rollback"
        ? "the Server Profile reports an older Project epoch than this installation already accepted"
        : "the Project Epoch Key differs from the one this installation already accepted for that epoch",
    );
    this.name = "ProjectEpochTrustError";
    this.code = code;
  }
}

const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const epochBytes = (epoch: number): Uint8Array => {
  if (!Number.isSafeInteger(epoch) || epoch < 1)
    throw new TypeError("Project epoch must be a positive safe integer");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(epoch));
  return bytes;
};

/** A one-way commitment to a Project Epoch Key, bound to its context. */
export const projectEpochKeyCommitment = async (
  input: Readonly<{
    readonly serverProfileId: string;
    readonly projectId: string;
    readonly epoch: number;
    readonly key: Uint8Array;
  }>,
): Promise<string> => {
  if (input.key.length !== 32)
    throw new TypeError("Project Epoch Key must be 32 bytes");
  const parts = [
    COMMITMENT_DOMAIN,
    uuidToBytes(input.serverProfileId),
    uuidToBytes(input.projectId),
    epochBytes(input.epoch),
    input.key,
  ];
  const message = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }
  try {
    return hex(await sha384(message));
  } finally {
    message.fill(0);
  }
};

const projectPin = (
  pins: AccountTrustPins,
  projectId: string,
): ProjectEpochPin | undefined => pins.projects?.[projectId.toLowerCase()];

/** The highest Project epoch this installation accepted, or 0. */
export const highestProjectEpoch = (
  pins: AccountTrustPins,
  projectId: string,
): number => projectPin(pins, projectId)?.highestEpoch ?? 0;

/** Throws when `epoch` is older than one this installation already accepted. */
export const assertProjectEpochCurrent = (
  pins: AccountTrustPins,
  projectId: string,
  epoch: number,
): void => {
  if (epoch < highestProjectEpoch(pins, projectId))
    throw new ProjectEpochTrustError("epoch-rollback");
};

/**
 * Checks Project Epoch Keys against this installation's pins without
 * recording anything: each key for an epoch already pinned must match.
 */
export const assertPinnedProjectEpochKeys = async (
  pins: AccountTrustPins,
  input: Readonly<{
    readonly serverProfileId: string;
    readonly projectId: string;
    readonly keys: ReadonlyMap<number, Uint8Array>;
  }>,
): Promise<void> => {
  const pinned = projectPin(pins, input.projectId)?.keys ?? {};
  for (const [epoch, key] of input.keys) {
    const expected = pinned[String(epoch)];
    if (expected === undefined) continue;
    const actual = await projectEpochKeyCommitment({
      serverProfileId: input.serverProfileId,
      projectId: input.projectId,
      epoch,
      key,
    });
    if (actual !== expected) throw new ProjectEpochTrustError("key-mismatch");
  }
};

/**
 * Records accepted Project Epoch Keys and raises the epoch high-water mark
 * to `currentEpoch`. A key that differs from one already pinned for its epoch
 * is refused, as is a `currentEpoch` below the mark.
 */
export const pinProjectEpochKeys = async (
  pins: AccountTrustPins,
  input: Readonly<{
    readonly serverProfileId: string;
    readonly projectId: string;
    readonly currentEpoch: number;
    readonly keys: ReadonlyMap<number, Uint8Array>;
  }>,
): Promise<Readonly<{ pins: AccountTrustPins; changed: boolean }>> => {
  assertProjectEpochCurrent(pins, input.projectId, input.currentEpoch);
  await assertPinnedProjectEpochKeys(pins, input);
  const projectId = input.projectId.toLowerCase();
  const previous = projectPin(pins, projectId);
  const keys: Record<string, string> = { ...(previous?.keys ?? {}) };
  let changed =
    previous === undefined || previous.highestEpoch < input.currentEpoch;
  for (const [epoch, key] of input.keys) {
    if (epoch > input.currentEpoch) continue;
    if (keys[String(epoch)] !== undefined) continue;
    keys[String(epoch)] = await projectEpochKeyCommitment({
      serverProfileId: input.serverProfileId,
      projectId,
      epoch,
      key,
    });
    changed = true;
  }
  if (!changed) return Object.freeze({ pins, changed: false });
  return Object.freeze({
    pins: Object.freeze({
      ...pins,
      projects: Object.freeze({
        ...(pins.projects ?? {}),
        [projectId]: Object.freeze({
          highestEpoch: Math.max(
            previous?.highestEpoch ?? 0,
            input.currentEpoch,
          ),
          keys: Object.freeze(keys),
        }),
      }),
    }),
    changed: true,
  });
};

/** Raises the epoch high-water mark without pinning a key. */
export const recordProjectEpoch = (
  pins: AccountTrustPins,
  projectId: string,
  epoch: number,
): Readonly<{ pins: AccountTrustPins; changed: boolean }> => {
  const key = projectId.toLowerCase();
  const previous = projectPin(pins, key);
  if (previous && previous.highestEpoch >= epoch)
    return Object.freeze({ pins, changed: false });
  return Object.freeze({
    pins: Object.freeze({
      ...pins,
      projects: Object.freeze({
        ...(pins.projects ?? {}),
        [key]: Object.freeze({
          highestEpoch: epoch,
          keys: previous?.keys ?? Object.freeze({}),
        }),
      }),
    }),
    changed: true,
  });
};
