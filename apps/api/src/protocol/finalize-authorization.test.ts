import { expect, test } from "bun:test";
import { testDeviceProof } from "../device-proof-testing";
import { createApi, loadServerProfileConfig } from "../index";

// A-5: finalize checks Membership before it reports anything about an
// Environment's state, such as its current head.
const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const environmentId = "44444444-4444-4444-8444-444444444444";
const revisionId = "55555555-5555-4555-8555-555555555555";
const otherTeamId = "66666666-6666-4666-8666-666666666666";
const teamHeadId = "77777777-7777-4777-8777-777777777777";

const body = {
  environmentId,
  expectedHeadId: "88888888-8888-4888-8888-888888888888",
  revision: {
    id: revisionId,
    protocolObjectId: revisionId,
    projectEpoch: 1,
    mutation: "MANIFEST_UPDATE",
    authoredAtMs: 1,
    parentHash: "00".repeat(48),
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

const create = (membership: Readonly<Record<string, unknown>> | null) => {
  const profile = loadServerProfileConfig({});
  const touched: string[] = [];
  const app = createApi({
    profile,
    auth: {
      api: {
        getSession: async () => ({
          session: { id: "session" },
          user: { id: "auth" },
        }),
      },
    } as never,
    database: {
      authAccount: { findFirst: async () => ({ accountId: "1001" }) },
      user: {
        upsert: async (input: { create: { githubSubject: string } }) => ({
          id: userId,
          githubSubject: input.create.githubSubject,
        }),
      },
      device: { findFirst: async () => ({ id: deviceId }) },
      operation: {
        findUnique: async () => ({
          id: operationId,
          actorUserId: userId,
          actorDeviceId: deviceId,
          kind: "REVISION_PUBLICATION",
          status: "STAGED",
          finalizationDigest: null,
          expiresAt: null,
        }),
      },
      environment: {
        findUnique: async () => ({
          id: environmentId,
          projectId: "99999999-9999-4999-8999-999999999999",
          currentHeadId: teamHeadId,
          lifecycle: "ACTIVE",
          project: { teamId: otherTeamId, lifecycle: "ACTIVE" },
        }),
      },
      membership: {
        findFirst: async ({
          where,
        }: {
          where: { teamId: string; userId: string };
        }) => {
          touched.push("membership");
          expect(where).toMatchObject({ teamId: otherTeamId, userId });
          return membership;
        },
      },
      stagedObject: {
        findMany: async () => {
          touched.push("staging");
          return [];
        },
      },
      $transaction: async () => {
        touched.push("transaction");
        throw new Error("a non-member's finalize must not reach the head");
      },
    } as never,
  });
  return { app, profile, touched };
};

const finalize = async (
  membership: Readonly<Record<string, unknown>> | null,
) => {
  const { app, profile, touched } = create(membership);
  const response = await app.request(
    `/api/v1/operations/${operationId}/finalize`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DotRelay-Device-Id": deviceId,
        "X-DotRelay-Device-Proof": await testDeviceProof(profile, {
          sessionId: "session",
          userId,
          deviceId,
        }),
      },
      body: JSON.stringify(body),
    },
  );
  return { response, touched };
};

test("a User outside the Team gets 404 and nothing about the head", async () => {
  for (const membership of [null, { lifecycle: "REMOVED" }]) {
    const { response, touched } = await finalize(membership);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain(teamHeadId);
    expect(JSON.parse(text)).toMatchObject({ code: "resource_not_found" });
    expect(touched).toEqual(["membership"]);
  }
});

test("a Member still waiting for keys is told so, without the head", async () => {
  const { response, touched } = await finalize({
    lifecycle: "PENDING_KEY_GRANT",
  });
  expect(response.status).toBe(403);
  const text = await response.text();
  expect(text).not.toContain(teamHeadId);
  expect(JSON.parse(text)).toMatchObject({ code: "membership_not_active" });
  expect(touched).toEqual(["membership"]);
});
