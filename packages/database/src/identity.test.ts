import { describe, expect, test } from "bun:test";
import { recordGitHubLogin, resolveDotRelayUser } from "./identity";

describe("DotRelay identity persistence", () => {
  test("selects the newest GitHub account deterministically", async () => {
    let lookup: unknown;
    const database = {
      authAccount: {
        findFirst: async (input: unknown) => {
          lookup = input;
          return { accountId: "github-account" };
        },
      },
      user: {
        upsert: async () => ({ id: "user-id" }),
      },
    } as never;

    await resolveDotRelayUser(database, {
      serverProfileId: "00000000-0000-4000-8000-000000000042",
      authSubject: "auth-subject",
    });

    expect(lookup).toEqual({
      where: { userId: "auth-subject", providerId: "github" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { accountId: true },
    });
  });

  // A-3: the GitHub account that created a User is that User's identity, and
  // the recorded GitHub subject never changes.
  test("refuses a sign-in whose GitHub account is not the User's recorded one", async () => {
    let update: unknown;
    const database = {
      authAccount: {
        findFirst: async () => ({ accountId: "other-github" }),
      },
      user: {
        upsert: async (input: { update: unknown }) => {
          update = input.update;
          return { id: "user-id", githubSubject: "original-github" };
        },
      },
    } as never;

    const user = await resolveDotRelayUser(database, {
      serverProfileId: "00000000-0000-4000-8000-000000000042",
      authSubject: "auth-subject",
    });
    expect(user).toBeNull();
    expect(update).toEqual({});
  });

  test("restores the Server Profile after an in-process development database reset", async () => {
    let profileExists = false;
    let attempts = 0;
    const database = {
      authAccount: {
        findFirst: async () => ({ accountId: "github-account" }),
      },
      serverProfile: {
        findUnique: async () =>
          profileExists ? { origin: "https://dev-api.dotrelay.dev" } : null,
        create: async () => {
          profileExists = true;
        },
      },
      user: {
        upsert: async () => {
          attempts += 1;
          if (!profileExists) throw { code: "P2003" };
          return { id: "user-id", githubSubject: "github-account" };
        },
      },
    } as never;

    const user = await resolveDotRelayUser(database, {
      serverProfileId: "00000000-0000-4000-8000-000000000042",
      serverProfileOrigin: "https://dev-api.dotrelay.dev",
      authSubject: "auth-subject",
    });
    expect(user).toEqual({ id: "user-id" });
    expect(attempts).toBe(2);
    expect(profileExists).toBe(true);
  });
});

describe("GitHub login records", () => {
  test("stores a valid login for its GitHub user id and ignores malformed input", async () => {
    const upserts: unknown[] = [];
    const database = {
      gitHubLogin: {
        upsert: async (input: unknown) => {
          upserts.push(input);
          return {};
        },
      },
    } as never;
    expect(
      await recordGitHubLogin(database, {
        githubSubject: "583231",
        login: "Octo-Cat",
      }),
    ).toBe(true);
    expect(upserts).toEqual([
      {
        where: { githubSubject: "583231" },
        create: { githubSubject: "583231", login: "Octo-Cat" },
        update: { login: "Octo-Cat" },
      },
    ]);
    for (const input of [
      { githubSubject: "583231", login: "-octo" },
      { githubSubject: "583231", login: "octo cat" },
      { githubSubject: "583231", login: "a".repeat(40) },
      { githubSubject: "not-a-number", login: "octo" },
    ])
      expect(await recordGitHubLogin(database, input)).toBe(false);
    expect(upserts).toHaveLength(1);
  });
});
