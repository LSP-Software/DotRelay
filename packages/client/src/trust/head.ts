import { type ProtocolObject, sha384 } from "@dotrelay/contracts";

export type TrustedHead = Readonly<{
  readonly environmentId: Uint8Array;
  readonly revisionId: Uint8Array;
  readonly revisionHash: Uint8Array;
}>;

export class HistoryTrustResetRequiredError extends Error {
  constructor() {
    super("history trust reset required");
    this.name = "HistoryTrustResetRequiredError";
  }
}

export class TrustedHeadContinuityError extends Error {
  constructor() {
    super("trusted head continuity refused");
    this.name = "TrustedHeadContinuityError";
  }
}

const headKey = (environmentId: Uint8Array): string =>
  [...environmentId].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const requireField = (
  object: ProtocolObject,
  field: number,
  length: number,
): Uint8Array => {
  const value = object.get(field);
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new TypeError(`field ${field} must be ${length} bytes`);
  return value;
};

export const trustedHeadFromRevision = (
  revision: ProtocolObject,
): TrustedHead => {
  if (revision.get(1) !== 16)
    throw new TypeError("expected revision protocol object");
  return Object.freeze({
    environmentId: requireField(revision, 14, 16),
    revisionId: requireField(revision, 16, 16),
    revisionHash: requireField(revision, 52, 48),
  });
};

export const revisionParentLink = (
  revision: ProtocolObject,
): Readonly<{ parentId: Uint8Array; parentHash: Uint8Array }> | null => {
  const parentId = revision.get(19);
  const parentHash = revision.get(20);
  if (parentId === undefined && parentHash === undefined) return null;
  if (!(parentId instanceof Uint8Array) || !(parentHash instanceof Uint8Array))
    throw new TypeError("revision parent link is malformed");
  if (parentId.length !== 16 || parentHash.length !== 48)
    throw new TypeError("revision parent link has invalid length");
  return Object.freeze({ parentId, parentHash });
};

export type TrustedHeadStore = Readonly<{
  get(environmentId: Uint8Array): TrustedHead | null;
  advance(head: TrustedHead, parent: TrustedHead | null): void;
  reset(environmentId: Uint8Array): void;
}>;

export const createTrustedHeadStore = (): TrustedHeadStore => {
  const heads = new Map<string, TrustedHead>();
  return Object.freeze({
    get: (environmentId) => heads.get(headKey(environmentId)) ?? null,
    advance: (head, parent) => {
      const current = heads.get(headKey(head.environmentId));
      if (!current) {
        heads.set(headKey(head.environmentId), head);
        return;
      }
      if (
        sameBytes(current.revisionId, head.revisionId) &&
        sameBytes(current.revisionHash, head.revisionHash)
      )
        return;
      if (
        !parent ||
        !sameBytes(current.revisionId, parent.revisionId) ||
        !sameBytes(current.revisionHash, parent.revisionHash)
      )
        throw new HistoryTrustResetRequiredError();
      heads.set(headKey(head.environmentId), head);
    },
    reset: (environmentId) => {
      heads.delete(headKey(environmentId));
    },
  });
};

export const hashRevisionBytes = async (
  revisionBytes: Uint8Array,
): Promise<Uint8Array> => sha384(revisionBytes);

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

export const acknowledgeHistoryTrustReset = (
  store: TrustedHeadStore,
  environmentId: Uint8Array,
  replacementHead: TrustedHead,
): void => {
  store.reset(environmentId);
  store.advance(replacementHead, null);
};
