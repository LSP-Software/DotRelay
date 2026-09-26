import { describe, expect, test } from "bun:test";
import "./fake-indexeddb.js";
import type { ServerProfilePin } from "@dotrelay/contracts";
import {
  createBrowserProfilePinStore,
  profilePinKey,
  resetMemoryProfilePinStore,
} from "./profile-pin";

type FakeIndexedDbHandle = {
  readonly setMode: (mode: string) => void;
  readonly commitAll: () => void;
  readonly reset: () => void;
};

const fakeIndexedDb = {
  install: (
    mode?: "healthy" | "hold-commits" | "abort-device-writes",
  ): void => {
    (
      globalThis as {
        __dotrelayFakeIndexedDb?: { readonly install: (mode?: string) => void };
      }
    ).__dotrelayFakeIndexedDb?.install(mode);
  },
  uninstall: (): void => {
    (
      globalThis as {
        __dotrelayFakeIndexedDb?: { readonly uninstall: () => void };
      }
    ).__dotrelayFakeIndexedDb?.uninstall();
  },
  get handle(): FakeIndexedDbHandle | undefined {
    return (globalThis as { __fakeIndexedDb?: FakeIndexedDbHandle })
      .__fakeIndexedDb;
  },
};

const pin = Object.freeze<ServerProfilePin>({
  serverProfileId: "00000000-0000-0000-0000-000000000001",
  origin: "https://profile.example.test",
});

const otherOriginPin = Object.freeze<ServerProfilePin>({
  serverProfileId: pin.serverProfileId,
  origin: "https://other.example.test",
});

const otherIdentityPin = Object.freeze<ServerProfilePin>({
  serverProfileId: "00000000-0000-0000-0000-000000000002",
  origin: pin.origin,
});

describe("browser profile pin store", () => {
  test("an existing pair-only pin blocks a changed identity during migration", async () => {
    const keys = new Set([profilePinKey(pin)]);
    const store = createBrowserProfilePinStore({
      recordStore: {
        read: async (key) => keys.has(key),
        keysForOrigin: async (origin) =>
          [...keys]
            .filter((key) => key.startsWith(`pin\0${origin}\0`))
            .map((key) => key.split("\0")[2] ?? ""),
        write: async (key) => {
          keys.add(key);
        },
        remove: async (key) => {
          keys.delete(key);
        },
      },
    });
    expect(await store.checkOrigin(otherIdentityPin)).toBe("changed");
    await expect(store.set(otherIdentityPin)).rejects.toThrow(
      "server identity changed",
    );
  });
  test("a memory-only fallback works in-page but is not claimed as durable", async () => {
    fakeIndexedDb.uninstall();
    resetMemoryProfilePinStore();
    const store = createBrowserProfilePinStore();
    expect(store.durable).toBe(false);
    expect(await store.has(pin)).toBe(false);
    await store.set(pin);
    expect(await store.has(pin)).toBe(true);
    await store.remove(pin);
    expect(await store.has(pin)).toBe(false);
  });

  test("a committed pin survives a reload through a fresh store", async () => {
    fakeIndexedDb.install("healthy");
    try {
      const store = createBrowserProfilePinStore();
      expect(store.durable).toBe(true);
      expect(await store.has(pin)).toBe(false);
      await store.set(pin);
      // A fresh store recovers the committed pin, as a reload would.
      const reloaded = createBrowserProfilePinStore();
      expect(await reloaded.has(pin)).toBe(true);
      await store.remove(pin);
      expect(await reloaded.has(pin)).toBe(false);
    } finally {
      fakeIndexedDb.handle?.reset();
      fakeIndexedDb.uninstall();
    }
  });

  test("a pin never carries over to a different origin or identity", async () => {
    fakeIndexedDb.install("healthy");
    try {
      const store = createBrowserProfilePinStore();
      await store.set(pin);
      expect(await store.has(pin)).toBe(true);
      expect(await store.has(otherOriginPin)).toBe(false);
      expect(await store.has(otherIdentityPin)).toBe(false);
      expect(await store.checkOrigin(otherIdentityPin)).toBe("changed");
      await expect(store.set(otherIdentityPin)).rejects.toThrow(
        "server identity changed",
      );
    } finally {
      fakeIndexedDb.handle?.reset();
      fakeIndexedDb.uninstall();
    }
  });

  test("an aborted write transaction stores no pin and rejects", async () => {
    fakeIndexedDb.install("abort-device-writes");
    try {
      const store = createBrowserProfilePinStore();
      await expect(store.set(pin)).rejects.toThrow();
      const fresh = createBrowserProfilePinStore();
      expect(await fresh.has(pin)).toBe(false);
    } finally {
      fakeIndexedDb.handle?.reset();
      fakeIndexedDb.uninstall();
    }
  });
});
