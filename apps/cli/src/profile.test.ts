import { describe, expect, test } from "bun:test";
import { createCapabilitiesDocument } from "@dotrelay/contracts";
import type { NetworkPolicy } from "./network";
import {
  addServerProfile,
  createFileProfileCatalog,
  resolveServerProfile,
  useServerProfile,
} from "./profile";

describe("CLI Server Profile catalog", () => {
  test("pins capabilities and selects the first saved profile", async () => {
    const path = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`;
    const store = createFileProfileCatalog(path);
    const capabilities = createCapabilitiesDocument({
      origin: "https://relay.example",
      serverProfileId: "00000000-0000-4000-8000-000000000042",
    });
    try {
      const profile = await addServerProfile(
        store,
        "work",
        capabilities.origin,
        {
          fetch: async () => Response.json(capabilities),
        },
      );
      expect(profile.pin.serverProfileId).toBe(capabilities.serverProfileId);
      expect((await resolveServerProfile(store)).name).toBe("work");
      await useServerProfile(store, "work");
      expect((await resolveServerProfile(store)).name).toBe("work");
    } finally {
      await (await import("node:fs/promises"))
        .unlink(path)
        .catch(() => undefined);
    }
  });

  test("rejects a capability response from a different origin", async () => {
    const store = createFileProfileCatalog(
      `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`,
    );
    await expect(
      addServerProfile(store, "work", "https://relay.example", {
        fetch: async () =>
          Response.json(
            createCapabilitiesDocument({ origin: "https://other.example" }),
          ),
      }),
    ).rejects.toThrow();
  });

  // Instant-sleep twin of the default policy so outage tests stay fast.
  const fastPolicy: NetworkPolicy = {
    requestDeadlineMs: 20,
    maxAttempts: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 2,
    sleep: async () => undefined,
    now: Date.now,
  };

  test("retries a transient capability failure before giving up", async () => {
    const path = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`;
    const store = createFileProfileCatalog(path);
    const capabilities = createCapabilitiesDocument({
      origin: "https://relay.example",
      serverProfileId: "00000000-0000-4000-8000-000000000042",
    });
    let calls = 0;
    try {
      const profile = await addServerProfile(
        store,
        "work",
        capabilities.origin,
        {
          networkPolicy: fastPolicy,
          fetch: async () => {
            calls += 1;
            if (calls <= 2) throw new TypeError("fetch failed");
            return Response.json(capabilities);
          },
        },
      );
      expect(profile.pin.serverProfileId).toBe(capabilities.serverProfileId);
      expect(calls).toBe(3);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(path)
        .catch(() => undefined);
    }
  });

  test("an unreachable capabilities endpoint ends in a retryable error", async () => {
    const store = createFileProfileCatalog(
      `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`,
    );
    let calls = 0;
    const error = await addServerProfile(
      store,
      "work",
      "https://relay.example",
      {
        networkPolicy: fastPolicy,
        fetch: async () => {
          calls += 1;
          throw new TypeError("fetch failed");
        },
      },
    ).catch((caught) => caught);
    expect(error).toMatchObject({
      category: "transient",
      code: "capabilities_unavailable",
    });
    expect(String((error as Error).message)).toContain(
      "could not reach the Server Profile capabilities endpoint after 3 attempts",
    );
    expect(calls).toBe(3);
  });

  test("does not persist a newly trusted profile when confirmation is declined", async () => {
    const path = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`;
    const store = createFileProfileCatalog(path);
    try {
      const capabilities = createCapabilitiesDocument({
        origin: "https://relay.example",
        serverProfileId: "00000000-0000-4000-8000-000000000042",
      });
      await expect(
        addServerProfile(store, "work", capabilities.origin, {
          fetch: async () => Response.json(capabilities),
          confirm: async () => false,
        }),
      ).rejects.toThrow("confirmation");
      expect((await store.read()).profiles).toEqual([]);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(path)
        .catch(() => undefined);
    }
  });
});
