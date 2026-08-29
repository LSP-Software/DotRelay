import { type ProtocolObject, parseProtocolObject } from "@dotrelay/contracts";
import { validateRevisionManifest } from "./manifest";

export type PublicationReview = Readonly<{
  readonly accepted: boolean;
  readonly mutationKind: number;
  readonly manifestVariables: number;
  readonly manifestLaneCommitments: number;
}>;

export const reviewPublication = (
  revisionBytes: Uint8Array,
): PublicationReview => {
  const revision = parseProtocolObject(revisionBytes);
  const mutationKind = revision.get(35);
  if (typeof mutationKind !== "number" || !Number.isSafeInteger(mutationKind))
    throw new TypeError("revision mutation kind is missing");
  const counts = validateRevisionManifest(revision);
  return Object.freeze({
    accepted: mutationKind === 1 || mutationKind === 2,
    mutationKind,
    manifestVariables: counts.variables,
    manifestLaneCommitments: counts.laneCommitments,
  });
};

export const assertPublicationAccepted = (review: PublicationReview): void => {
  if (!review.accepted)
    throw new Error("publication review rejected the revision mutation");
};

export const isRollbackRevision = (revision: ProtocolObject): boolean =>
  revision.get(1) === 16 && revision.get(35) === 3;

export const validateRollbackRevision = (
  revisionBytes: Uint8Array,
): Readonly<{
  rollbackTargetId: Uint8Array;
  selectedLanes: readonly unknown[];
}> => {
  const revision = parseProtocolObject(revisionBytes);
  if (!isRollbackRevision(revision))
    throw new TypeError("expected rollback revision");
  const rollbackTargetId = revision.get(21);
  const selectedLanes = revision.get(68);
  if (
    !(rollbackTargetId instanceof Uint8Array) ||
    rollbackTargetId.length !== 16
  )
    throw new TypeError("rollback target revision id is invalid");
  if (!Array.isArray(selectedLanes))
    throw new TypeError("rollback selected lanes are missing");
  return Object.freeze({
    rollbackTargetId,
    selectedLanes,
  });
};
