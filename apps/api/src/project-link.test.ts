import { expect, test } from "bun:test";
import { testDeviceProof } from "./device-proof-testing";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

// A-6: a Project links only a repository the acting User's Delegated GitHub
// Access resolves to the same identity (ADR 0003).
const userId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const teamId = "33333333-3333-4333-8333-333333333333";

const linkProject = async (
  github: (url: string) => Response,
  githubRepositoryId = "1311418611",
) => {
  const profile = loadServerProfileConfig({});
  const githubCalls: string[] = [];
  let transactions = 0;
  const app = createApi({
    profile,
    auth: {
      api: {
        getSession: async () => ({
          session: { id: "session" },
          user: { id: "auth-user", name: "Ari" },
        }),
      },
      $context: Promise.resolve({
        options: {},
        secretConfig: { secret: "test-secret" },
        internalAdapter: {
          findAccounts: async () => [
            { providerId: "github", accessToken: "ghu_delegated-token" },
          ],
        },
      }),
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
      $transaction: async () => {
        transactions += 1;
        throw new Error("stop after authorization");
      },
    } as never,
    githubFetch: (async (input: string | URL | Request) => {
      githubCalls.push(String(input));
      return github(String(input));
    }) as typeof fetch,
  });
  const response = await app.request(`${profile.origin}/api/v1/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      "X-DotRelay-Device-Id": deviceId,
      "X-DotRelay-Device-Proof": await testDeviceProof(profile, {
        sessionId: "session",
        userId,
        deviceId,
      }),
    },
    body: JSON.stringify({
      teamId,
      repositoryHost: "github.com",
      repositoryOwner: "LSP-Software",
      repositoryName: "DotRelay",
      githubRepositoryId,
    }),
  });
  return { response, githubCalls, transactions: () => transactions };
};

test("a repository the User's GitHub access cannot see is not linked", async () => {
  const { response, githubCalls, transactions } = await linkProject(
    () => new Response(null, { status: 404 }),
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "repository_access_denied",
  });
  expect(githubCalls).toEqual([
    "https://api.github.com/repos/LSP-Software/DotRelay",
  ]);
  expect(transactions()).toBe(0);
});

test("an id GitHub does not report for that repository is not linked", async () => {
  const { response, transactions } = await linkProject(
    () => Response.json({ id: 999, full_name: "LSP-Software/DotRelay" }),
    "1311418611",
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "repository_access_denied",
  });
  expect(transactions()).toBe(0);
});

test("a repository the User can see goes on to be linked", async () => {
  const { transactions } = await linkProject(() =>
    Response.json({ id: 1311418611, full_name: "LSP-Software/DotRelay" }),
  );
  expect(transactions()).toBe(1);
});
