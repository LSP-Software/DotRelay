import { describe, expect, test } from "bun:test";
import { resolveDotRelayUser } from "./identity";

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
});
