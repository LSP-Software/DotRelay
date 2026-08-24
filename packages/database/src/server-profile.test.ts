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

  test("accepts a profile created concurrently by another instance", async () => {
    let lookupCount = 0;
    const database = {
      serverProfile: {
        findUnique: async () => {
          lookupCount += 1;
          return lookupCount === 1 ? null : { origin: "https://relay.example" };
        },
        update: async () => undefined,
        create: async () => {
          throw Object.assign(new Error("unique constraint"), {
            code: "P2002",
          });
        },
      },
    } as never;

    await expect(
      ensureServerProfile(database, {
        id: "00000000-0000-4000-8000-000000000042",
        origin: "https://relay.example",
        allowRebind: false,
      }),
    ).resolves.toBeUndefined();
    expect(lookupCount).toBe(2);
  });

  test("describes an origin conflict when the profile id is absent", async () => {
    const database = {
      serverProfile: {
        findUnique: async () => null,
        update: async () => undefined,
        create: async () => {
          throw Object.assign(new Error("unique constraint"), {
            code: "P2002",
          });
        },
      },
    } as never;

    await expect(
      ensureServerProfile(database, {
        id: "00000000-0000-4000-8000-000000000042",
        origin: "https://relay.example",
        allowRebind: false,
      }),
    ).rejects.toThrow("already assigned to another server profile");
  });

  test("describes an origin conflict during rebind", async () => {
    const database = {
      serverProfile: {
        findUnique: async () => ({ origin: "https://old.example" }),
        update: async () => {
          throw Object.assign(new Error("unique constraint"), {
            code: "P2002",
          });
        },
        create: async () => undefined,
      },
    } as never;

    await expect(
      ensureServerProfile(database, {
        id: "00000000-0000-4000-8000-000000000042",
        origin: "https://new.example",
        allowRebind: true,
      }),
    ).rejects.toThrow("already assigned to another server profile");
  });
});
