import { expect, test } from "bun:test";
import { PublicationRepository } from "./publication";
import { MembershipNotActiveError, StaleHeadError } from "./repository-core";

// A-5: a non-member's publication fails on Membership before any check that
// reports the Environment's state, so its head never reaches them in a
// stale-head or genesis-exists problem.
test("Membership is checked before the head", async () => {
  const transaction = {
    $executeRaw: async () => 0,
    environment: {
      findUnique: async () => ({
        id: "environment",
        projectId: "project",
        currentHeadId: "victim-head",
        lifecycle: "ACTIVE",
        project: {
          teamId: "other-team",
          lifecycle: "ACTIVE",
          currentEpoch: 1n,
        },
      }),
    },
    operation: { findUnique: async () => null },
    device: { findFirst: async () => ({ id: "device", activatedAt: null }) },
    membership: { findFirst: async () => null },
    revision: { findUnique: async () => null },
  };
  const database = {
    $transaction: async (callback: (client: unknown) => Promise<unknown>) =>
      callback(transaction),
  };
  let failure: unknown;
  try {
    await new PublicationRepository().publishRevision(
      database as never,
      {
        environmentId: "environment",
        expectedHeadId: "stale-head",
        operation: {
          id: "operation",
          actorUserId: "outsider",
          actorDeviceId: "device",
          kind: "REVISION_PUBLICATION",
          commandBytes: new Uint8Array(),
          commandDigest: new Uint8Array(48),
        },
        revision: {
          mutation: "MANIFEST_UPDATE",
          projectEpoch: 1n,
          parentHash: new Uint8Array(48),
        },
      } as never,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(MembershipNotActiveError);
  expect(failure).not.toBeInstanceOf(StaleHeadError);
});
