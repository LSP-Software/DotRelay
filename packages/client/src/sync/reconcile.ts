import {
  createProblem,
  type Problem,
  type ProblemCode,
} from "@dotrelay/contracts";
import type { TrustedHead } from "../trust/head";

export type ReconciliationInput = Readonly<{
  readonly localHead: TrustedHead | null;
  readonly serverHead: TrustedHead;
  readonly serverParent: TrustedHead | null;
  readonly projectEpoch: number;
  readonly expectedEpoch: number;
}>;

export type ReconciliationOutcome =
  | Readonly<{ readonly kind: "aligned"; readonly head: TrustedHead }>
  | Readonly<{ readonly kind: "advance"; readonly head: TrustedHead }>
  | Readonly<{ readonly kind: "conflict"; readonly problem: Problem }>;

export const reconcileHead = (
  input: ReconciliationInput,
): ReconciliationOutcome => {
  if (input.expectedEpoch !== input.projectEpoch)
    return conflict("stale_epoch");
  if (input.localHead && sameHead(input.localHead, input.serverHead))
    return Object.freeze({ kind: "aligned", head: input.serverHead });
  if (input.localHead === null)
    return Object.freeze({ kind: "advance", head: input.serverHead });
  if (input.serverParent && sameHead(input.localHead, input.serverParent))
    return Object.freeze({ kind: "advance", head: input.serverHead });
  return conflict("stale_head");
};

const conflict = (code: ProblemCode): ReconciliationOutcome =>
  Object.freeze({
    kind: "conflict",
    problem: createProblem(code),
  });

const sameHead = (left: TrustedHead, right: TrustedHead): boolean => {
  return (
    sameBytes(left.environmentId, right.environmentId) &&
    sameBytes(left.revisionId, right.revisionId) &&
    sameBytes(left.revisionHash, right.revisionHash)
  );
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

export type EquivocationReport = Readonly<{
  readonly environmentId: Uint8Array;
  readonly firstHead: TrustedHead;
  readonly conflictingHead: TrustedHead;
}>;

export const detectEquivocation = (
  observed: readonly TrustedHead[],
): EquivocationReport | null => {
  const byEnvironment = new Map<string, TrustedHead>();
  for (const head of observed) {
    const key = [...head.environmentId]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const existing = byEnvironment.get(key);
    if (
      existing &&
      (!sameBytes(existing.revisionId, head.revisionId) ||
        !sameBytes(existing.revisionHash, head.revisionHash))
    ) {
      return Object.freeze({
        environmentId: head.environmentId,
        firstHead: existing,
        conflictingHead: head,
      });
    }
    byEnvironment.set(key, head);
  }
  return null;
};
