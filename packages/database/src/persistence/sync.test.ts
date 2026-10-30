import { describe, expect, test } from "bun:test";
import { SyncRepository } from "./sync";

const environmentId = "00000000-0000-4000-8000-000000000001";
const parentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const childId = "11111111-1111-4111-8111-111111111111";
const laterId = "22222222-2222-4222-8222-222222222222";
const revision = (id: string, parentId: string | null, digest: number) => ({
  id,
  parentId,
  environmentId,
  parentHash: parentId ? new Uint8Array(48).fill(digest - 1) : null,
  acceptedAt: new Date("2026-10-30T12:00:00.000Z"),
  protocolObjectId: id,
  protocolObject: {
    digest: new Uint8Array(48).fill(digest),
    canonicalBytes: new Uint8Array([digest]),
  },
  manifestDescriptor: null,
  commitments: [],
  projectEpoch: 1n,
  mutation: parentId ? "MANIFEST_UPDATE" : "GENESIS",
  authoredAtMs: 1n,
  rollbackTargetId: null,
});
const fixture = () => {
  const rows = [revision(parentId, null, 1), revision(childId, parentId, 2)];
  const environment = {
    id: environmentId,
    projectId: "project",
    label: "development",
    lifecycle: "ACTIVE",
    currentHeadId: childId,
    currentHead: { protocolObject: rows[1]!.protocolObject },
    project: { currentEpoch: 1n, lifecycle: "ACTIVE", teamId: "team" },
  };
  let beforePage: (() => void) | undefined;
  const database = {
    device: { findFirst: async () => ({ id: "device" }) },
    membership: {
      findFirst: async () => ({ lifecycle: "ACTIVE", role: "OWNER" }),
      findUnique: async () => ({ lifecycle: "ACTIVE", role: "OWNER" }),
    },
    environment: {
      findFirst: async () => environment,
      findUnique: async () => ({ ...environment }),
    },
    revision: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null,
      findMany: async ({ where }: { where: { id?: { in: string[] } } }) => {
        beforePage?.();
        // Deliberately return rows in UUID order, never parent order.
        return rows
          .filter((row) => !where.id || where.id.in.includes(row.id))
          .sort((a, b) => a.id.localeCompare(b.id));
      },
    },
  };
  const input = {
    actorUserId: "user",
    actorDeviceId: "device",
    environmentId,
    trustedRevisionId: environmentId,
    trustedRevisionHash: new Uint8Array(48),
    limit: 1,
  };
  return {
    rows,
    environment,
    database,
    input,
    beforePage: (callback: () => void) => {
      beforePage = callback;
    },
  };
};

describe("sync parent-chain pagination", () => {
  test("paginates tied timestamps in parent order and resumes from the trusted parent", async () => {
    const { database, input, rows } = fixture();
    const repository = new SyncRepository();
    const first = await repository.synchronize(database as never, input);
    expect(first.revisions.map((row) => row.id)).toEqual([parentId]);
    expect(first.nextCursor?.revisionId).toBe(parentId);
    const second = await repository.synchronize(database as never, {
      ...input,
      cursorRevisionId: parentId,
      cursorRevisionHash: rows[0]!.protocolObject.digest,
    });
    expect(second.revisions.map((row) => row.id)).toEqual([childId]);
    expect(second.nextCursor).toBeNull();
    const resumed = await repository.synchronize(database as never, {
      ...input,
      trustedRevisionId: parentId,
      trustedRevisionHash: rows[0]!.protocolObject.digest,
    });
    expect(resumed.revisions.map((row) => row.id)).toEqual([childId]);
  });

  test("bounds the returned chain to the captured head during a concurrent publication", async () => {
    const { database, input, rows, environment, beforePage } = fixture();
    beforePage(() => {
      rows.push(revision(laterId, childId, 3));
      environment.currentHeadId = laterId;
      environment.currentHead = { protocolObject: rows[2]!.protocolObject };
    });
    const page = await new SyncRepository().synchronize(database as never, {
      ...input,
      limit: 16,
    });
    expect(page.currentHeadId).toBe(childId);
    expect(page.revisions.map((row) => row.id)).toEqual([parentId, childId]);
    expect(page.nextCursor).toBeNull();
  });

  test("rejects a cursor beyond the advertised head and a broken parent chain", async () => {
    const { database, input, rows } = fixture();
    rows.push(revision(laterId, childId, 3));
    await expect(
      new SyncRepository().synchronize(database as never, {
        ...input,
        cursorRevisionId: laterId,
        cursorRevisionHash: rows[2]!.protocolObject.digest,
      }),
    ).rejects.toThrow("not on the advertised head's chain");
    rows.splice(0, 1);
    await expect(
      new SyncRepository().synchronize(database as never, input),
    ).rejects.toThrow("history is incomplete");
  });
});
