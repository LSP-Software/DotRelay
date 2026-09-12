import { expect, test } from "bun:test";
import {
  browserDeviceIdKey,
  probeBrowserLocalStorage,
  readStoredBrowserDeviceId,
  writeStoredBrowserDeviceId,
} from "./browser-storage";

type StorageLike = Readonly<{
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}>;

const setWindow = (storage?: StorageLike): void => {
  (globalThis as Record<string, unknown>).window =
    storage === undefined
      ? undefined
      : {
          localStorage: {
            getItem: (key: string) => storage?.getItem(key) ?? null,
            setItem: (key: string, value: string) =>
              storage?.setItem(key, value),
            removeItem: (key: string) => storage?.removeItem(key),
          },
        };
};

const healthyStorage = (): StorageLike => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
};

test("persists and reads back the stored Device id", () => {
  setWindow(healthyStorage());
  writeStoredBrowserDeviceId(
    "https://relay.dotrelay.dev",
    "profile-1",
    "device-1",
  );
  expect(
    readStoredBrowserDeviceId("https://relay.dotrelay.dev", "profile-1"),
  ).toBe("device-1");
});

test("keys Device ids by origin and Server Profile id", () => {
  setWindow(healthyStorage());
  writeStoredBrowserDeviceId("https://a.test", "profile-1", "device-1");
  writeStoredBrowserDeviceId("https://b.test", "profile-1", "device-2");
  expect(browserDeviceIdKey("https://a.test", "profile-1")).toBe(
    "dotrelay.browser-device:https://a.test:profile-1",
  );
  expect(readStoredBrowserDeviceId("https://a.test", "profile-1")).toBe(
    "device-1",
  );
  expect(readStoredBrowserDeviceId("https://b.test", "profile-1")).toBe(
    "device-2",
  );
  expect(readStoredBrowserDeviceId("https://a.test", "profile-2")).toBeNull();
});

test("a denied local storage write surfaces as an error instead of a silent loss", () => {
  const denied: StorageLike = {
    getItem: () => {
      throw new DOMException("local storage is denied", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("local storage is denied", "SecurityError");
    },
    removeItem: () => {
      throw new DOMException("local storage is denied", "SecurityError");
    },
  };
  setWindow(denied);
  expect(() =>
    writeStoredBrowserDeviceId("origin", "profile", "device"),
  ).toThrow();
  expect(probeBrowserLocalStorage()).toBe(false);
  expect(readStoredBrowserDeviceId("origin", "profile")).toBeNull();
});

test("quota exhaustion is reported, not swallowed", () => {
  const values = new Map<string, string>();
  const quota: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (key.startsWith("dotrelay.browser-device"))
        throw new DOMException("quota exceeded", "QuotaExceededError");
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  setWindow(quota);
  expect(() =>
    writeStoredBrowserDeviceId("origin", "profile", "device"),
  ).toThrow();
  expect(readStoredBrowserDeviceId("origin", "profile")).toBeNull();
  // The probe key is still writable, so the probe alone cannot see the
  // device-id quota failure; the strict write above is what catches it.
  expect(probeBrowserLocalStorage()).toBe(true);
});

test("a write that does not survive a read back is reported", () => {
  const values = new Map<string, string>();
  const tampered: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, `${value}-tampered`);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  setWindow(tampered);
  expect(() =>
    writeStoredBrowserDeviceId("origin", "profile", "device"),
  ).toThrow("could not keep the Device id");
});
