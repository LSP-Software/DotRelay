import { describe, expect, test } from "bun:test";
import { createCapabilitiesDocument } from "@dotrelay/contracts";
import {
  addServerProfile,
  createFileProfileCatalog,
  resolveServerProfile,
  useServerProfile,
} from "./profile";

describe("CLI Server Profile catalog", () => {
  test("pins capabilities and does not select a profile implicitly", async () => {
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
      await expect(resolveServerProfile(store)).rejects.toThrow(
        "No Server Profile selected",
      );
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
