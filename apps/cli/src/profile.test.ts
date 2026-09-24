import { describe, expect, test } from "bun:test";
import { createCapabilitiesDocument } from "@dotrelay/contracts";
import type { NetworkPolicy } from "./network";
import {
  addServerProfile,
  createFileProfileCatalog,
  resolveServerProfile,
  useServerProfile,
} from "./profile";
import { defaultOrigin } from "./version";

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
      "could not reach the Server Profile capabilities endpoint at https://relay.example after 3 attempts",
    );
    expect(calls).toBe(3);
  });

  test("completes a bare host as an https origin", async () => {
    const path = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`;
    const store = createFileProfileCatalog(path);
    const capabilities = createCapabilitiesDocument({
      origin: "https://relay.example",
      serverProfileId: "00000000-0000-4000-8000-000000000042",
    });
    const seen: string[] = [];
    try {
      const profile = await addServerProfile(store, "work", "relay.example", {
        fetch: (input) => {
          seen.push(String(input));
          return Promise.resolve(Response.json(capabilities));
        },
      });
      expect(profile.origin).toBe("https://relay.example");
      expect(seen).toEqual(["https://relay.example/api/v1/capabilities"]);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(path)
        .catch(() => undefined);
    }
  });

  test("falls back to plain HTTP on loopback when HTTPS is unreachable", async () => {
    const path = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`;
    const store = createFileProfileCatalog(path);
    const capabilities = createCapabilitiesDocument({
      origin: "http://127.0.0.1:8443",
      serverProfileId: "00000000-0000-4000-8000-000000000042",
    });
    const seen: string[] = [];
    try {
      const profile = await addServerProfile(store, "lab", "127.0.0.1:8443", {
        networkPolicy: fastPolicy,
        fetch: (input) => {
          const url = String(input);
          seen.push(url);
          if (url.startsWith("https://"))
            return Promise.reject(new TypeError("fetch failed"));
          return Promise.resolve(Response.json(capabilities));
        },
      });
      expect(profile.origin).toBe("http://127.0.0.1:8443");
      expect(seen.filter((url) => url.startsWith("https://"))).toEqual(
        Array.from(
          { length: fastPolicy.maxAttempts },
          () => "https://127.0.0.1:8443/api/v1/capabilities",
        ),
      );
      expect(seen.filter((url) => url.startsWith("http://"))).toEqual([
        "http://127.0.0.1:8443/api/v1/capabilities",
      ]);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(path)
        .catch(() => undefined);
    }
  });

  test("an explicit https origin is never retried over plain HTTP", async () => {
    const store = createFileProfileCatalog(
      `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`,
    );
    const seen: string[] = [];
    const error = await addServerProfile(
      store,
      "work",
      "https://relay.example",
      {
        networkPolicy: fastPolicy,
        fetch: (input) => {
          seen.push(String(input));
          return Promise.reject(new TypeError("fetch failed"));
        },
      },
    ).catch((caught) => caught);
    expect(error).toMatchObject({
      category: "transient",
      code: "capabilities_unavailable",
    });
    expect(seen.length).toBe(fastPolicy.maxAttempts);
    expect(seen.every((url) => url.startsWith("https://"))).toBe(true);
  });

  test("a non-loopback origin is never retried over plain HTTP", async () => {
    const store = createFileProfileCatalog(
      `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`,
    );
    const seen: string[] = [];
    const error = await addServerProfile(store, "work", "relay.example", {
      networkPolicy: fastPolicy,
      fetch: (input) => {
        seen.push(String(input));
        return Promise.reject(new TypeError("fetch failed"));
      },
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      category: "transient",
      code: "capabilities_unavailable",
    });
    expect(seen.length).toBe(fastPolicy.maxAttempts);
    expect(seen.every((url) => url.startsWith("https://"))).toBe(true);
  });

  test("source builds ship no build-time default origin", () => {
    // Release and source builds stamp no default origin, so a first use
    // still requires an explicit `dotrelay setup <origin>` trust decision;
    // only dev builds stamp the origin they target.
    expect(defaultOrigin).toBeUndefined();
  });

  const devOrigin = "https://dev-api.dotrelay.dev";
  const devProfileId = "00000000-0000-4000-8000-000000000077";

  test("seeds and selects the build's default origin on first use", async () => {
    const path = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`;
    const store = createFileProfileCatalog(path);
    const capabilities = createCapabilitiesDocument({
      origin: devOrigin,
      serverProfileId: devProfileId,
    });
    try {
      // No confirmation is offered: the operator installed a build that
      // already declared this destination, so first use trusts it as-is.
      const profile = await resolveServerProfile(store, undefined, {
        defaultOrigin: devOrigin,
        fetch: async () => Response.json(capabilities),
      });
      expect(profile.origin).toBe(devOrigin);
      expect(profile.name).toBe("dev-api.dotrelay.dev");
      expect(profile.pin.serverProfileId).toBe(devProfileId);
      const catalog = await store.read();
      expect(catalog.selected).toBe("dev-api.dotrelay.dev");
      expect(catalog.profiles.map((entry) => entry.origin)).toEqual([
        devOrigin,
      ]);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(path)
        .catch(() => undefined);
    }
  });

  test("selects a saved default-origin profile without re-fetching", async () => {
    const path = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`;
    const store = createFileProfileCatalog(path);
    await (await import("node:fs/promises")).writeFile(
      path,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            name: "dev-api.dotrelay.dev",
            origin: devOrigin,
            pin: { origin: devOrigin, serverProfileId: devProfileId },
          },
        ],
      }),
    );
    try {
      const profile = await resolveServerProfile(store, undefined, {
        defaultOrigin: devOrigin,
        fetch: async () => {
          throw new Error("a saved default profile must not be re-fetched");
        },
      });
      expect(profile.origin).toBe(devOrigin);
      expect((await store.read()).selected).toBe("dev-api.dotrelay.dev");
    } finally {
      await (await import("node:fs/promises"))
        .unlink(path)
        .catch(() => undefined);
    }
  });

  test("an explicit profile override still wins over the default origin", async () => {
    const path = `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`;
    const store = createFileProfileCatalog(path);
    await (await import("node:fs/promises")).writeFile(
      path,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            name: "work",
            origin: "https://relay.example",
            pin: {
              origin: "https://relay.example",
              serverProfileId: "00000000-0000-4000-8000-000000000042",
            },
          },
        ],
      }),
    );
    try {
      const profile = await resolveServerProfile(store, "work", {
        defaultOrigin: devOrigin,
        fetch: async () => {
          throw new Error("an override must not trigger default seeding");
        },
      });
      expect(profile.name).toBe("work");
      expect(profile.origin).toBe("https://relay.example");
    } finally {
      await (await import("node:fs/promises"))
        .unlink(path)
        .catch(() => undefined);
    }
  });

  test("a build without a default origin still requires setup", async () => {
    const store = createFileProfileCatalog(
      `${import.meta.dir}/.tmp-profile-${crypto.randomUUID()}.json`,
    );
    await expect(
      resolveServerProfile(store, undefined, {
        fetch: async () => {
          throw new Error("setup must not be skipped without a default origin");
        },
      }),
    ).rejects.toThrow(
      "No Server Profile selected; run dotrelay setup <origin>",
    );
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
