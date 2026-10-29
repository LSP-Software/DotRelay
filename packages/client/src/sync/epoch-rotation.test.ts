import { describe, expect, test } from "bun:test";
import {
  generateSigningKeyPair,
  parseProtocolObject,
  sha384,
} from "@dotrelay/contracts";
import {
  type EpochRotationEnvironment,
  createEpochRotationArtifacts,
} from "./epoch-rotation";

const ids = {
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  actorUserId: "55555555-5555-4555-8555-555555555555",
  actorDeviceId: "66666666-6666-4666-8666-666666666666",
};

const environment = (
  environmentId: string,
  expectedHeadId: string,
  expectedHeadHash: Uint8Array,
): EpochRotationEnvironment =>
  Object.freeze({ environmentId, expectedHeadId, expectedHeadHash });

describe("epoch rotation artifacts", () => {
  test("signs an empty epoch transition for the next epoch", async () => {
    const signing = await generateSigningKeyPair();
    const expectedHeadHash = new Uint8Array(48).fill(9);
    const artifacts = await createEpochRotationArtifacts({
      ...ids,
      expectedEpoch: 1,
      environments: [
        environment(
          "44444444-4444-4444-8444-444444444444",
          "77777777-7777-4777-8777-777777777777",
          expectedHeadHash,
        ),
      ],
      signingPrivateKey: signing.privateKey,
      authoredAtMs: 1_700_000_000_000,
    });
    expect(artifacts.request.expectedEpoch).toBe(1);
    expect(artifacts.request.newEpoch).toBe(2);
    expect(artifacts.request.transitions).toHaveLength(1);
    const transition = artifacts.request.transitions[0];
    if (!transition) throw new Error("transition missing");
    expect(transition.publication.lanes).toHaveLength(0);
    expect(transition.publication.revision.mutation).toBe("EPOCH_TRANSITION");
    expect(transition.publication.revision.projectEpoch).toBe(2);
    expect(transition.publication.revision.parentHash).toEqual(
      expectedHeadHash,
    );
    const command = parseProtocolObject(artifacts.commandBytes);
    expect(command.get(1)).toBe(12);
    expect(command.get(62)).toBe(1);
    expect(command.get(63)).toBe(2);
    const revision = artifacts.stagedObjects.find(
      (object) =>
        object.objectId === transition.publication.revision.protocolObjectId,
    );
    if (!revision) throw new Error("revision missing");
    const revisionObject = parseProtocolObject(revision.bytes);
    expect(revisionObject.get(1)).toBe(16);
    expect(revisionObject.get(35)).toBe(4);
    expect(revisionObject.get(30)).toBe(2);
    expect(command.get(67)).toEqual(await sha384(revision.bytes));
  });

  test("rotates every active environment in one shared operation", async () => {
    const signing = await generateSigningKeyPair();
    const artifacts = await createEpochRotationArtifacts({
      ...ids,
      expectedEpoch: 3,
      environments: [
        // Out of order on purpose: the client must sort by environmentId so
        // the transitions match the backend's ordering.
        environment(
          "20000000-0000-4000-8000-000000000002",
          "40000000-0000-4000-8000-000000000004",
          new Uint8Array(48).fill(2),
        ),
        environment(
          "10000000-0000-4000-8000-000000000001",
          "30000000-0000-4000-8000-000000000003",
          new Uint8Array(48).fill(1),
        ),
      ],
      signingPrivateKey: signing.privateKey,
      authoredAtMs: 1_700_000_000_000,
    });
    expect(artifacts.request.expectedEpoch).toBe(3);
    expect(artifacts.request.newEpoch).toBe(4);
    expect(
      artifacts.request.transitions.map(
        (transition) => transition.environmentId,
      ),
    ).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ]);
    for (const transition of artifacts.request.transitions) {
      expect(transition.publication.revision.projectEpoch).toBe(4);
      expect(transition.publication.revision.mutation).toBe("EPOCH_TRANSITION");
      expect(transition.publication.lanes).toHaveLength(0);
    }
    // Each environment stages its own descriptor, revision, and transition.
    expect(artifacts.stagedObjects).toHaveLength(6);
    // The single command object is the first (smallest environmentId)
    // transition, sharing the project-wide epoch bump.
    const first = artifacts.request.transitions[0];
    if (!first) throw new Error("first transition missing");
    const command = parseProtocolObject(artifacts.commandBytes);
    expect(command.get(1)).toBe(12);
    expect(command.get(62)).toBe(3);
    expect(command.get(63)).toBe(4);
    const firstRevision = artifacts.stagedObjects.find(
      (object) =>
        object.objectId === first.publication.revision.protocolObjectId,
    );
    if (!firstRevision) throw new Error("first revision missing");
    expect(command.get(67)).toEqual(await sha384(firstRevision.bytes));
  });

  test("rejects a rotation that has no verified parent revision", async () => {
    const signing = await generateSigningKeyPair();
    await expect(
      createEpochRotationArtifacts({
        ...ids,
        expectedEpoch: 1,
        environments: [
          environment(
            "44444444-4444-4444-8444-444444444444",
            "77777777-7777-4777-8777-777777777777",
            new Uint8Array(16),
          ),
        ],
        signingPrivateKey: signing.privateKey,
      }),
    ).rejects.toThrow("project epoch rotation context is invalid");
  });
});
