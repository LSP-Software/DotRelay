import type { ServerProfilePin } from "@dotrelay/contracts";
import {
  type DevicePrivateBundle,
  encodeDevicePrivateBundle,
  parseDevicePrivateBundle,
} from "../device/bundle";
import {
  type DeviceRecordStore,
  type DeviceStorageScope,
  type EncryptedDeviceRecord,
  scopeKey,
  zeroize,
} from "./types";
import {
  createWrappingKey,
  unwrapBytes,
  wrapBytes,
  wrappingAssociatedData,
} from "./wrapping";

export type BrowserDeviceStorage = Readonly<{
  save(bundle: DevicePrivateBundle): Promise<void>;
  load(scope: DeviceStorageScope): Promise<DevicePrivateBundle>;
  remove(scope: DeviceStorageScope): Promise<void>;
  wipe(): Promise<void>;
}>;

const records = new Map<string, EncryptedDeviceRecord>();
const wrappingKeys = new Map<string, CryptoKey>();

type IndexedRequest<T> = {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
};
type IndexedStore = {
  get(key: string): IndexedRequest<EncryptedDeviceRecord | undefined>;
  getAll(): IndexedRequest<
    Array<EncryptedDeviceRecord & { readonly key: string }>
  >;
  put(value: unknown): IndexedRequest<unknown>;
  delete(key: string): IndexedRequest<unknown>;
};
type IndexedDatabase = {
  close(): void;
  createObjectStore(name: string, options: { keyPath: string }): void;
  transaction(
    store: string,
    mode: "readonly" | "readwrite",
  ): { objectStore(name: string): IndexedStore };
};
type IndexedFactory = {
  open(
    name: string,
    version: number,
  ): IndexedRequest<IndexedDatabase> & {
    onupgradeneeded: (() => void) | null;
  };
};

const indexedFactory = (): IndexedFactory | undefined =>
  (globalThis as unknown as { indexedDB?: IndexedFactory }).indexedDB;

export const createMemoryDeviceRecordStore = (): DeviceRecordStore =>
  Object.freeze({
    read: async (scope) => records.get(scopeKey(scope)) ?? null,
    write: async (record) => {
      records.set(scopeKey(record.scope), record);
    },
    remove: async (scope) => {
      records.delete(scopeKey(scope));
    },
    wipe: async (pin) => {
      for (const [key, record] of records) {
        if (
          record.scope.pin.origin === pin.origin &&
          record.scope.pin.serverProfileId === pin.serverProfileId
        )
          records.delete(key);
      }
    },
  });

export const createIndexedDbDeviceRecordStore = (
  databaseName = "dotrelay-device",
): DeviceRecordStore => {
  const openDatabase = (): Promise<IndexedDatabase> =>
    new Promise((resolve, reject) => {
      const factory = indexedFactory();
      if (!factory) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = factory.open(databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("records", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const transact = async <T>(
    mode: "readonly" | "readwrite",
    callback: (store: IndexedStore) => IndexedRequest<T>,
  ): Promise<T> => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = callback(
        database.transaction("records", mode).objectStore("records"),
      );
      request.onsuccess = () => {
        database.close();
        resolve(request.result);
      };
      request.onerror = () => {
        database.close();
        reject(request.error);
      };
    });
  };
  return Object.freeze({
    read: async (scope) =>
      (await transact<EncryptedDeviceRecord | undefined>("readonly", (store) =>
        store.get(scopeKey(scope)),
      )) ?? null,
    write: async (record) => {
      await transact<unknown>("readwrite", (store) =>
        store.put({ ...record, key: scopeKey(record.scope) }),
      );
    },
    remove: async (scope) => {
      await transact<unknown>("readwrite", (store) =>
        store.delete(scopeKey(scope)),
      );
    },
    wipe: async (pin) => {
      const entries = await transact<
        Array<EncryptedDeviceRecord & { readonly key: string }>
      >("readonly", (store) => store.getAll());
      for (const entry of entries) {
        if (
          entry.scope.pin.origin === pin.origin &&
          entry.scope.pin.serverProfileId === pin.serverProfileId
        )
          await transact<unknown>("readwrite", (store) =>
            store.delete(entry.key),
          );
      }
    },
  });
};

export const createBrowserDeviceStorage = (
  pin: ServerProfilePin,
  options?: Readonly<{
    readonly recordStore?: DeviceRecordStore;
    readonly runtime?: Crypto;
  }>,
): BrowserDeviceStorage => {
  const runtime = options?.runtime ?? globalThis.crypto;
  const recordStore =
    options?.recordStore ??
    (indexedFactory() === undefined
      ? createMemoryDeviceRecordStore()
      : createIndexedDbDeviceRecordStore());
  const pinKey = `${pin.origin}\0${pin.serverProfileId}`;

  const resolveWrappingKey = async (): Promise<CryptoKey> => {
    let wrappingKey = wrappingKeys.get(pinKey);
    if (!wrappingKey) {
      wrappingKey = await createWrappingKey(runtime);
      wrappingKeys.set(pinKey, wrappingKey);
    }
    return wrappingKey;
  };

  return Object.freeze({
    save: async (bundle) => {
      if (
        bundle.pin.serverProfileId !== pin.serverProfileId ||
        bundle.pin.origin !== pin.origin
      )
        throw new Error("device bundle origin or profile isolation violation");
      const wrappingKey = await resolveWrappingKey();
      const associatedData = wrappingAssociatedData(pin, bundle.deviceId);
      let plaintext: Uint8Array | undefined;
      try {
        plaintext = encodeDevicePrivateBundle(bundle);
        const wrapped = await wrapBytes(
          wrappingKey,
          plaintext,
          associatedData,
          runtime,
        );
        await recordStore.write(
          Object.freeze({
            version: 1,
            scope: Object.freeze({ pin, deviceId: bundle.deviceId }),
            iv: wrapped.iv,
            ciphertext: wrapped.ciphertext,
            wrappingKey,
          }),
        );
      } finally {
        zeroize(plaintext);
      }
    },
    load: async (scope) => {
      if (
        scope.pin.serverProfileId !== pin.serverProfileId ||
        scope.pin.origin !== pin.origin
      )
        throw new Error("device storage scope isolation violation");
      const record = await recordStore.read(scope);
      if (!record) throw new Error("encrypted device bundle is missing");
      const wrappingKey = record.wrappingKey ?? (await resolveWrappingKey());
      wrappingKeys.set(pinKey, wrappingKey);
      const associatedData = wrappingAssociatedData(pin, scope.deviceId);
      let plaintext: Uint8Array | undefined;
      try {
        plaintext = await unwrapBytes(
          wrappingKey,
          record.iv,
          record.ciphertext,
          associatedData,
          runtime,
        );
        return parseDevicePrivateBundle(plaintext, pin);
      } finally {
        zeroize(plaintext);
      }
    },
    remove: async (scope) => {
      await recordStore.remove(scope);
    },
    wipe: async () => {
      wrappingKeys.delete(pinKey);
      await recordStore.wipe?.(pin);
    },
  });
};

export const resetMemoryDeviceRecordStore = (): void => {
  records.clear();
  wrappingKeys.clear();
};
