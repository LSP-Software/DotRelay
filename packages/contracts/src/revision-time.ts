/**
 * How far past the judge's clock a Revision's signer-chosen authored-at
 * instant may lie. Clients and the service apply the same bound: Device and
 * Membership windows are judged at that instant, so an unbounded future
 * would let a signer move a Revision into whichever window authorizes it.
 */
export const MAX_REVISION_CLOCK_SKEW_MS = 10 * 60 * 1000;

export type RevisionAuthoredAtVerdict =
  "ok" | "before_not_before" | "after_clock_skew";

const toBigInt = (value: bigint | number): bigint =>
  typeof value === "bigint" ? value : BigInt(Math.floor(value));

/**
 * The single rule both sides use for a Revision's authored-at instant
 * (field 34). It must not precede `notBeforeMs` (the latest of the signing
 * Device's activation, the author's Membership activation, and the parent
 * Revision's authored-at instant), and must not lie more than
 * MAX_REVISION_CLOCK_SKEW_MS past `nowMs`. The service rejects a publication
 * that breaks it, so no client ever receives a head it must refuse.
 */
export const checkRevisionAuthoredAt = (
  input: Readonly<{
    readonly authoredAtMs: bigint | number;
    readonly notBeforeMs?: bigint | number | null;
    readonly nowMs: bigint | number;
  }>,
): RevisionAuthoredAtVerdict => {
  const authoredAtMs = toBigInt(input.authoredAtMs);
  if (
    input.notBeforeMs !== undefined &&
    input.notBeforeMs !== null &&
    authoredAtMs < toBigInt(input.notBeforeMs)
  )
    return "before_not_before";
  if (authoredAtMs > toBigInt(input.nowMs) + BigInt(MAX_REVISION_CLOCK_SKEW_MS))
    return "after_clock_skew";
  return "ok";
};

/**
 * The authored-at instant a client should sign: its own clock, raised to the
 * not-before floor it knows about. A Device whose clock runs slow then still
 * produces a Revision every client accepts.
 */
export const chooseRevisionAuthoredAtMs = (
  nowMs: number,
  notBeforeMs?: number | null,
): number => {
  const now = Math.floor(nowMs);
  return typeof notBeforeMs === "number" && Number.isSafeInteger(notBeforeMs)
    ? Math.max(now, notBeforeMs)
    : now;
};
