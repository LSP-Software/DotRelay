import { describe, expect, test } from "bun:test";
import { emptyAccountTrustPins } from "./account-trust";
import {
  assertProjectEpochCurrent,
  highestProjectEpoch,
  ProjectEpochTrustError,
  pinProjectEpochKeys,
  projectEpochKeyCommitment,
  recordProjectEpoch,
} from "./project-epochs";

const serverProfileId = "11111111-1111-4111-8111-111111111111";
const projectId = "33333333-3333-4333-8333-333333333333";
const key = (fill: number) => new Uint8Array(32).fill(fill);

describe("Project epoch pins (ADR 0022)", () => {
  test("a commitment is bound to its Server Profile, Project, epoch and key", async () => {
    const base = { serverProfileId, projectId, epoch: 1, key: key(1) };
    const commitment = await projectEpochKeyCommitment(base);
    expect(commitment).toMatch(/^[0-9a-f]{96}$/);
    for (const changed of [
      { ...base, serverProfileId: projectId },
      { ...base, projectId: serverProfileId },
      { ...base, epoch: 2 },
      { ...base, key: key(2) },
    ])
      expect(await projectEpochKeyCommitment(changed)).not.toBe(commitment);
  });

  test("a key adopted for an epoch cannot be swapped later", async () => {
    const first = await pinProjectEpochKeys(emptyAccountTrustPins(), {
      serverProfileId,
      projectId,
      currentEpoch: 2,
      keys: new Map([
        [1, key(1)],
        [2, key(2)],
      ]),
    });
    expect(first.changed).toBe(true);
    expect(highestProjectEpoch(first.pins, projectId)).toBe(2);
    // The same keys again change nothing.
    const again = await pinProjectEpochKeys(first.pins, {
      serverProfileId,
      projectId,
      currentEpoch: 2,
      keys: new Map([[2, key(2)]]),
    });
    expect(again.changed).toBe(false);
    // A different key for a pinned epoch is refused.
    await expect(
      pinProjectEpochKeys(first.pins, {
        serverProfileId,
        projectId,
        currentEpoch: 2,
        keys: new Map([[2, key(9)]]),
      }),
    ).rejects.toMatchObject({ code: "key-mismatch" });
  });

  test("a Project epoch never goes below the high-water mark", async () => {
    const { pins } = recordProjectEpoch(emptyAccountTrustPins(), projectId, 3);
    expect(() => assertProjectEpochCurrent(pins, projectId, 3)).not.toThrow();
    expect(() => assertProjectEpochCurrent(pins, projectId, 2)).toThrow(
      ProjectEpochTrustError,
    );
    await expect(
      pinProjectEpochKeys(pins, {
        serverProfileId,
        projectId,
        currentEpoch: 2,
        keys: new Map([[2, key(2)]]),
      }),
    ).rejects.toMatchObject({ code: "epoch-rollback" });
    // Recording a lower epoch never lowers the mark.
    expect(recordProjectEpoch(pins, projectId, 1).changed).toBe(false);
  });
});
