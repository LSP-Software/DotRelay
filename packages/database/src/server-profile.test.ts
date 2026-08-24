import { describe, expect, test } from "bun:test";
import { ensureServerProfile } from "./server-profile";

describe("server profile persistence", () => {
  test("fails closed on a persisted origin change unless explicitly rebound", async () => {
    const updates: unknown[] = [];
    const database = {
      serverProfile: {
        findUnique: async () => ({ origin: "https://old.example" }),
        update: async (input: unknown) => updates.push(input),
        create: async () => undefined,
      },
    } as never;

    await expect(
      ensureServerProfile(database, {
        id: "00000000-0000-4000-8000-000000000042",
        origin: "https://new.example",
        allowRebind: false,
      }),
    ).rejects.toThrow("SERVER_PROFILE_REBIND=true");

    await ensureServerProfile(database, {
      id: "00000000-0000-4000-8000-000000000042",
      origin: "https://new.example",
      allowRebind: true,
    });
    expect(updates).toHaveLength(1);
  });
});
