import { expect, test } from "bun:test";
import { createProtocolTransport, type FinalizeInput } from "./transport";
import { PublicationUncertainError } from "./publication-recovery";

const input: FinalizeInput = {
  operationId: "11111111-1111-4111-8111-111111111111",
  deviceId: "22222222-2222-4222-8222-222222222222",
  request: {
    environmentId: "33333333-3333-4333-8333-333333333333",
    expectedHeadId: null,
    revision: {
      id: "44444444-4444-4444-8444-444444444444",
      protocolObjectId: "55555555-5555-4555-8555-555555555555",
      projectEpoch: 1,
      mutation: "GENESIS",
      authoredAtMs: 1,
    },
    descriptor: {
      protocolObjectId: "66666666-6666-4666-8666-666666666666",
      schemaVersion: 1,
      descriptorHash: new Uint8Array(48),
      laneCount: 0,
    },
    lanes: [],
    commitments: [],
  },
};

test("a lost finalize response is reconciled to the original committed Revision", async () => {
  let commits = 0;
  let cancelled = false;
  const transport = createProtocolTransport({
    origin: "https://relay.example",
    fetch: async (url, init) => {
      if (init?.method === "DELETE") cancelled = true;
      if (url.endsWith("/finalize")) {
        commits++;
        throw new TypeError("response lost");
      }
      return Response.json({
        status: "COMMITTED",
        revisionIds: [input.request.revision.id],
      });
    },
  });
  expect(await transport.finalize(input)).toEqual({
    revisionId: input.request.revision.id,
    idempotent: true,
  });
  expect(commits).toBe(1);
  expect(cancelled).toBe(false);
});

test("offline outcomes persist across client restart and block fresh operations until reconciled", async () => {
  let pending: string | null = null;
  let offline = true;
  const finalized: string[] = [];
  const create = () =>
    createProtocolTransport({
      origin: "https://relay.example",
      pendingPublication: {
        read: async () => pending,
        write: async (value) => {
          pending = value;
        },
      },
      fetch: async (url, init) => {
        if (url.endsWith("/finalize")) finalized.push(String(init?.body));
        if (offline) throw new TypeError("offline");
        return Response.json({
          revisionId: input.request.revision.id,
          idempotent: true,
        });
      },
    });
  await expect(create().finalize(input)).rejects.toBeInstanceOf(
    PublicationUncertainError,
  );
  expect(pending).not.toBeNull();
  await expect(
    create().begin({
      operationId: "new",
      deviceId: input.deviceId,
      kind: "REVISION_PUBLICATION",
      commandBytes: new Uint8Array(),
      commandDigest: new Uint8Array(48),
    }),
  ).rejects.toBeInstanceOf(PublicationUncertainError);
  offline = false;
  const client = create();
  expect(await client.recoverPublication?.()).toEqual({
    revisionId: input.request.revision.id,
    idempotent: true,
  });
  expect(pending).toBeNull();
  expect(new Set(finalized).size).toBe(1);
});

test("an unpersisted publication is never sent", async () => {
  let calls = 0;
  const transport = createProtocolTransport({
    origin: "https://relay.example",
    pendingPublication: {
      read: async () => null,
      write: async () => {
        throw new Error("disk full");
      },
    },
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await expect(transport.finalize(input)).rejects.toThrow("disk full");
  expect(calls).toBe(0);
});
