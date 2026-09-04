import { describe, expect, test } from "bun:test";
import { createDevicePrivateBundle } from "../device/bundle";
import { createInMemoryDiagnosticSink } from "../diagnostics/event";
import {
  createBrowserDeviceStorage,
  createMemoryDeviceRecordStore,
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
