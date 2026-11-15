import { describe, expect, test } from "bun:test";
import { findMember, parseMembers } from "./workflow-share-keys";

const members = parseMembers([
  {
    membershipId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    name: "Octo Cat",
    githubSubject: "583231",
    githubLogin: "OctoCat",
    lifecycle: "PENDING_KEY_GRANT",
  },
  {
    membershipId: "33333333-3333-4333-8333-333333333333",
    userId: "44444444-4444-4444-8444-444444444444",
    name: "Hub Ot",
    githubSubject: "1001",
    githubLogin: null,
    lifecycle: "ACTIVE",
  },
]);

const adminResolving = (githubUserId: string, calls: string[]) => ({
  post: async (path: string) => {
    calls.push(path);
    return { login: "resolved", githubUserId };
  },
});

describe("team share-keys Member lookup", () => {
  test("matches a listed login case-insensitively without resolving it", async () => {
    const calls: string[] = [];
    const member = await findMember(
      adminResolving("0", calls) as never,
      members,
      "octocat",
    );
    expect(member.userId).toBe("22222222-2222-4222-8222-222222222222");
    expect(calls).toEqual([]);
  });

  test("falls back to resolving a login the list does not carry", async () => {
    const calls: string[] = [];
    const member = await findMember(
      adminResolving("1001", calls) as never,
      members,
      "hubot",
    );
    expect(member.userId).toBe("44444444-4444-4444-8444-444444444444");
    expect(calls).toEqual(["/api/v1/github-users/resolve"]);
  });

  test("resolves instead of guessing when two Members list the same login", async () => {
    const calls: string[] = [];
    const duplicated = parseMembers([
      {
        membershipId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        githubSubject: "583231",
        githubLogin: "octocat",
      },
      {
        membershipId: "33333333-3333-4333-8333-333333333333",
        userId: "44444444-4444-4444-8444-444444444444",
        githubSubject: "1001",
        githubLogin: "OctoCat",
      },
    ]);
    const member = await findMember(
      adminResolving("1001", calls) as never,
      duplicated,
      "octocat",
    );
    expect(member.userId).toBe("44444444-4444-4444-8444-444444444444");
    expect(calls).toEqual(["/api/v1/github-users/resolve"]);
  });
});
