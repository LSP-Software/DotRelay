import { describe, expect, test } from "bun:test";
import { createProblem } from "@dotrelay/contracts";
import { detectEquivocation, reconcileHead } from "./reconcile";

const environmentId = new Uint8Array(16).fill(2);
const trustedHead = (revisionByte: number) =>
  Object.freeze({
    environmentId,
    revisionId: new Uint8Array(16).fill(revisionByte),
    revisionHash: new Uint8Array(48).fill(revisionByte),
  });

describe("local reconciliation", () => {
  test("reports stale epoch conflicts", () => {
    const outcome = reconcileHead({
      localHead: null,
      serverHead: trustedHead(1),
      serverParent: null,
      projectEpoch: 2,
      expectedEpoch: 1,
    });
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind === "conflict")
      expect(outcome.problem.code).toBe("stale_epoch");
  });

  test("advances when the server head extends the local head", () => {
    const local = trustedHead(1);
    const server = trustedHead(2);
    const outcome = reconcileHead({
      localHead: local,
      serverHead: server,
      serverParent: local,
      projectEpoch: 3,
      expectedEpoch: 3,
    });
    expect(outcome).toEqual({ kind: "advance", head: server });
  });

  test("detects equivocation across observed heads", () => {
    const report = detectEquivocation([trustedHead(1), trustedHead(2)]);
    expect(report?.conflictingHead.revisionId).toEqual(
      trustedHead(2).revisionId,
    );
  });

  test("maps stale head conflicts to stable problem categories", () => {
    const problem = createProblem("stale_head");
    expect(problem.code).toBe("stale_head");
  });
});
