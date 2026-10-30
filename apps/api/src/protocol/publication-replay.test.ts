import { expect, test } from "bun:test";
import { createApi, loadServerProfileConfig } from "../index";

const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const environmentId = "44444444-4444-4444-8444-444444444444";
const revisionId = "55555555-5555-4555-8555-555555555555";
const body = {
  environmentId,
  expectedHeadId: null,
  revision: {
    id: revisionId,
    protocolObjectId: revisionId,
    projectEpoch: 1,
    mutation: "GENESIS",
    authoredAtMs: 1,
  },
  descriptor: {
    protocolObjectId: operationId,
    schemaVersion: 1,
    descriptorHash: "00".repeat(48),
    laneCount: 0,
  },
  lanes: [],
  commitments: [],
};
const create = (kind = "REVISION_PUBLICATION", owner = userId) => {
  const profile = loadServerProfileConfig({});
  return createApi({
    profile,
    auth: {
      api: { getSession: async () => ({ user: { id: "auth" } }) },
    } as never,
    database: {
      authAccount: { findFirst: async () => ({ accountId: "1001" }) },
      user: { upsert: async () => ({ id: userId }) },
      device: { findFirst: async () => ({ id: deviceId }) },
      operation: {
        findUnique: async () => ({
          id: operationId,
          actorUserId: owner,
          actorDeviceId: deviceId,
          kind,
          status: "COMMITTED",
          revisions: [{ id: revisionId }],
        }),
      },
      revision: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === revisionId ? { id: revisionId } : null,
      },
      stagedObject: {
        findMany: async () => {
          throw new Error("committed staging must not be read");
        },
      },
    } as never,
  });
};
const headers = {
  "Content-Type": "application/json",
  "X-DotRelay-Device-Id": deviceId,
};

test("committed finalize returns its original receipt without staging, even after cleanup", async () => {
  const response = await create().request(
    `/api/v1/operations/${operationId}/finalize`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revisionId, idempotent: true });
});

test("finalize refuses another operation kind and a different Revision on replay", async () => {
  for (const [app, request] of [
    [create("EPOCH_ROTATION"), body],
    [create(), { ...body, revision: { ...body.revision, id: operationId } }],
  ] as const) {
    expect(
      (
        await app.request(`/api/v1/operations/${operationId}/finalize`, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(409);
  }
});

test("operation receipts require the owning User and active Device", async () => {
  const path = `/api/v1/operations/${operationId}`;
  const result = await create().request(path, { headers });
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toEqual({
    operationId,
    status: "COMMITTED",
    revisionIds: [revisionId],
  });
  expect(
    (await create("REVISION_PUBLICATION", "foreign").request(path, { headers }))
      .status,
  ).toBe(404);
});
