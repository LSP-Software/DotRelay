import { describe, expect, test } from "bun:test";
import "./fake-indexeddb.js";
import { createDevicePrivateBundle } from "../device/bundle";
import { createInMemoryDiagnosticSink } from "../diagnostics/event";
import {
  createBrowserDeviceStorage,
  createMemoryDeviceRecordStore,
  probeBrowserDeviceStorage,
  resetMemoryDeviceRecordStore,
} from "./browser";
import {
  createCliDeviceStorage,
  createMemoryCredentialStore,
  resetMemoryCredentialStore,
} from "./cli";
import { credentialAccount, legacyCredentialAccount, zeroize } from "./types";
import { unwrapBytes, wrapBytes, wrappingAssociatedData } from "./wrapping";

const pin = Object.freeze({
  serverProfileId: "00000000-0000-0000-0000-000000000001",
  origin: "https://profile.example.test",
});

describe("device storage wrapping", () => {
  test("binds associated data to origin, profile, and device id", async () => {
    const deviceId = new Uint8Array(16).fill(3);
    const aad = wrappingAssociatedData(pin, deviceId);
    expect(aad.byteLength).toBeGreaterThan(32);
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const plaintext = new TextEncoder().encode("bundle");
    const wrapped = await wrapBytes(key, plaintext, aad);
    const opened = await unwrapBytes(key, wrapped.iv, wrapped.ciphertext, aad);
    expect(opened).toEqual(plaintext);
    await expect(
      unwrapBytes(
        key,
        wrapped.iv,
        wrapped.ciphertext,
        wrappingAssociatedData(
          { ...pin, origin: "https://other.example.test" },
          deviceId,
        ),
      ),
    ).rejects.toThrow();
  });

  test("zeroizes temporary plaintext buffers", () => {
    const buffer = new Uint8Array([1, 2, 3]);
    zeroize(buffer);
    expect([...buffer]).toEqual([0, 0, 0]);
  });
});

describe("browser device storage", () => {
  test("persists and reloads an encrypted bundle for one origin/profile", async () => {
    resetMemoryDeviceRecordStore();
    const storage = createBrowserDeviceStorage(pin);
    const deviceId = crypto.getRandomValues(new Uint8Array(16));
    const bundle = await createDevicePrivateBundle({
      pin,
      userId: crypto.getRandomValues(new Uint8Array(16)),
      deviceId,
      userIdentityGeneration: 2,
    });
    await storage.save(bundle);
    const loaded = await storage.load({ pin, deviceId });
    expect(loaded.userIdentityGeneration).toBe(2);
  });

  test("emits only local value-blind diagnostics", async () => {
    resetMemoryDeviceRecordStore();
    const diagnostics = createInMemoryDiagnosticSink(() => 0);
    const storage = createBrowserDeviceStorage(pin, { diagnostics });
    const deviceId = crypto.getRandomValues(new Uint8Array(16));
    const bundle = await createDevicePrivateBundle({
      pin,
      userId: crypto.getRandomValues(new Uint8Array(16)),
      deviceId,
      userIdentityGeneration: 1,
    });
    await storage.save(bundle);
    await storage.load({ pin, deviceId });
    const records = diagnostics.records();
    expect(records).toHaveLength(2);
    expect(records.join(" ")).not.toContain(pin.serverProfileId);
    expect(records.join(" ")).not.toContain("ciphertext");
  });

  test("isolates bundles across origins and profiles", async () => {
    resetMemoryDeviceRecordStore();
    const otherPin = Object.freeze({
      serverProfileId: pin.serverProfileId,
      origin: "https://other.example.test",
    });
    const storage = createBrowserDeviceStorage(pin);
    const deviceId = crypto.getRandomValues(new Uint8Array(16));
    const bundle = await createDevicePrivateBundle({
      pin,
      userId: crypto.getRandomValues(new Uint8Array(16)),
      deviceId,
      userIdentityGeneration: 1,
    });
    await storage.save(bundle);
    await expect(storage.load({ pin: otherPin, deviceId })).rejects.toThrow(
      "isolation",
    );
  });
});

describe("cli device storage", () => {
  test("stores wrapping secrets outside the encrypted bundle record", async () => {
    resetMemoryDeviceRecordStore();
    resetMemoryCredentialStore();
    const credentialStore = createMemoryCredentialStore();
    const storage = createCliDeviceStorage(pin, credentialStore);
    const deviceId = crypto.getRandomValues(new Uint8Array(16));
    const bundle = await createDevicePrivateBundle({
      pin,
      userId: crypto.getRandomValues(new Uint8Array(16)),
      deviceId,
      userIdentityGeneration: 4,
    });
    await storage.save(bundle);
    const secret = await credentialStore.get(
      "dotrelay-device-wrap",
      credentialAccount({ pin, deviceId }),
    );
    expect(secret?.length).toBe(32);
    expect(credentialAccount({ pin, deviceId })).not.toContain("\0");
    const loaded = await storage.load({ pin, deviceId });
    expect(loaded.userIdentityGeneration).toBe(4);
    await storage.remove({ pin, deviceId });
    await expect(storage.load({ pin, deviceId })).rejects.toThrow();
  });

  test("migrates a legacy wrapping secret before loading a bundle", async () => {
    resetMemoryDeviceRecordStore();
    resetMemoryCredentialStore();
    const credentialStore = createMemoryCredentialStore();
    const recordStore = createMemoryDeviceRecordStore();
    const storage = createCliDeviceStorage(pin, credentialStore, {
      recordStore,
    });
    const deviceId = crypto.getRandomValues(new Uint8Array(16));
    const bundle = await createDevicePrivateBundle({
      pin,
      userId: crypto.getRandomValues(new Uint8Array(16)),
      deviceId,
      userIdentityGeneration: 1,
    });
    await storage.save(bundle);
    const current = await credentialStore.get(
      "dotrelay-device-wrap",
      credentialAccount({ pin, deviceId }),
    );
    if (!current) throw new Error("current wrapping secret is missing");
    await credentialStore.delete(
      "dotrelay-device-wrap",
      credentialAccount({ pin, deviceId }),
    );
    await credentialStore.set(
      "dotrelay-device-wrap",
      legacyCredentialAccount({ pin, deviceId }),
      current,
    );
    await storage.load({ pin, deviceId });
    expect(
      await credentialStore.get(
        "dotrelay-device-wrap",
        credentialAccount({ pin, deviceId }),
      ),
    ).toEqual(current);
    expect(
      await credentialStore.get(
        "dotrelay-device-wrap",
        legacyCredentialAccount({ pin, deviceId }),
      ),
    ).toBeNull();
  });
});

type FakeIndexedDbHandle = Readonly<{
  readonly setMode: (
    mode: "healthy" | "hold-commits" | "abort-device-writes",
  ) => void;
  readonly commitAll: () => void;
  readonly reset: () => void;
}>;

const fakeIndexedDb = {
  install: (
    mode?: "healthy" | "hold-commits" | "abort-device-writes",
  ): void => {
    (
      globalThis as {
        __dotrelayFakeIndexedDb?: {
          readonly install: (mode?: string) => void;
        };
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

describe("browser device storage durability", () => {
  const createTestBundle = async (userIdentityGeneration: number) => {
    const deviceId = crypto.getRandomValues(new Uint8Array(16));
    const bundle = await createDevicePrivateBundle({
      pin,
      userId: crypto.getRandomValues(new Uint8Array(16)),
      deviceId,
      userIdentityGeneration,
    });
    return { deviceId, bundle };
  };

  test("a memory-only fallback works in-page but is not claimed as durable", async () => {
    fakeIndexedDb.uninstall();
    resetMemoryDeviceRecordStore();
    const storage = createBrowserDeviceStorage(pin);
    expect(storage.durable).toBe(false);
    const { deviceId, bundle } = await createTestBundle(7);
    await storage.save(bundle);
    const loaded = await storage.load({ pin, deviceId });
    expect(loaded.userIdentityGeneration).toBe(7);
  });

  test("preflight probe reports non-durable when IndexedDB is unavailable", async () => {
    fakeIndexedDb.uninstall();
    expect(await probeBrowserDeviceStorage()).toEqual({ durable: false });
  });

  test("preflight probe reports durable storage that commits and reads back", async () => {
    fakeIndexedDb.install("healthy");
    try {
      expect(await probeBrowserDeviceStorage()).toEqual({ durable: true });
    } finally {
      fakeIndexedDb.uninstall();
    }
  });

  test("a write is only durable after the transaction commits", async () => {
    fakeIndexedDb.install("hold-commits");
    try {
      const storage = createBrowserDeviceStorage(pin);
      expect(storage.durable).toBe(true);
      const { deviceId, bundle } = await createTestBundle(8);
      const saving = storage.save(bundle);
      let resolved = false;
      void saving.then(() => {
        resolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(resolved).toBe(false);
      fakeIndexedDb.handle?.setMode("healthy");
      fakeIndexedDb.handle?.commitAll();
      await saving;
      // A fresh storage instance recovers the committed record, as a reload
      // and a fresh enrollment flow would.
      const fresh = createBrowserDeviceStorage(pin);
      const loaded = await fresh.load({ pin, deviceId });
      expect(loaded.userIdentityGeneration).toBe(8);
    } finally {
      fakeIndexedDb.handle?.reset();
      fakeIndexedDb.uninstall();
    }
  });

  test("an aborted write transaction stores nothing and rejects", async () => {
    fakeIndexedDb.install("abort-device-writes");
    try {
      // Probe writes commit, so the preflight passes even while device record
      // writes are being rejected by the storage backend.
      expect(await probeBrowserDeviceStorage()).toEqual({ durable: true });
      const storage = createBrowserDeviceStorage(pin);
      const { deviceId, bundle } = await createTestBundle(9);
      await expect(storage.save(bundle)).rejects.toThrow("QuotaExceededError");
      const fresh = createBrowserDeviceStorage(pin);
      await expect(fresh.load({ pin, deviceId })).rejects.toThrow();
    } finally {
      fakeIndexedDb.handle?.reset();
      fakeIndexedDb.uninstall();
    }
  });
});
