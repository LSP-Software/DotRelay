import { afterEach, expect, test } from "bun:test";
import { forgetThisBrowser } from "./browser-storage";

const original = {
  window: (globalThis as Record<string, unknown>).window,
  indexedDB: (globalThis as Record<string, unknown>).indexedDB,
};
afterEach(() => {
  (globalThis as Record<string, unknown>).window = original.window;
  (globalThis as Record<string, unknown>).indexedDB = original.indexedDB;
});

test("forgetting this browser removes the sealed account key and Device", async () => {
  const values = new Map<string, string>([
    ["dotrelay.account-key:v1:https://api.example:p:u:d", "sealed"],
    ["dotrelay.browser-device:https://api.example:p", "device"],
    ["dotrelay-publication:x:y:z:d:op", "journal"],
    ["unrelated", "kept"],
  ]);
  const localStorage = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  (globalThis as Record<string, unknown>).window = { localStorage };
  const deleted: string[] = [];
  (globalThis as Record<string, unknown>).indexedDB = {
    deleteDatabase: (name: string) => {
      deleted.push(name);
      const request: Record<string, unknown> = {};
      queueMicrotask(() => (request.onsuccess as () => void)?.());
      return request;
    },
  };

  await forgetThisBrowser();

  expect([...values.keys()]).toEqual(["unrelated"]);
  expect(deleted.sort()).toEqual(["dotrelay-device", "dotrelay-profile-pins"]);
});
