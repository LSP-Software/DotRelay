import type { ServerProfilePin } from "@dotrelay/contracts";
import {
  type DevicePrivateBundle,
  encodeDevicePrivateBundle,
  parseDevicePrivateBundle,
} from "../device/bundle";
import {
  createCorrelationId,
  createDiagnosticEvent,
  type DiagnosticSink,
} from "../diagnostics/event";
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
  /**
   * True only when records are held by IndexedDB and therefore survive a
   * page reload. A memory-only fallback can serve this page load but cannot
   * be claimed as durable enrollment.
   */
  readonly durable: boolean;
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
type IndexedTransaction = {
  readonly error: unknown;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  objectStore(name: string): IndexedStore;
};
type IndexedDatabase = {
  close(): void;
  createObjectStore(name: string, options: { keyPath: string }): void;
  transaction(
    store: string,
    mode: "readonly" | "readwrite",
  ): IndexedTransaction;
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
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("records", mode);
      const request = callback(transaction.objectStore("records"));
      let result: T | undefined;
      let hasResult = false;
      let settled = false;
      // A request succeeding only means the operation ran inside the
      // transaction; the data is durable only once the transaction commits.
      const settle = (settleWith: () => void) => {
        if (settled) return;
        settled = true;
        database.close();
        settleWith();
      };
      request.onsuccess = () => {
        result = request.result;
        hasResult = true;
      };
      request.onerror = () => {
        settle(() =>
          reject(
            request.error instanceof Error
              ? request.error
              : new Error("IndexedDB request failed"),
          ),
        );
      };
      transaction.oncomplete = () => {
        settle(() => resolve(hasResult ? (result as T) : (undefined as T)));
      };
      transaction.onerror = () => {
        settle(() =>
          reject(
            transaction.error instanceof Error
              ? transaction.error
              : new Error("IndexedDB transaction failed"),
          ),
        );
      };
      transaction.onabort = () => {
        settle(() =>
          reject(
            transaction.error instanceof Error
              ? transaction.error
              : new Error("IndexedDB transaction aborted"),
          ),
        );
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

const PROBE_PIN = Object.freeze({
  serverProfileId: "00000000-0000-0000-0000-000000000000",
  origin: "dotrelay.storage-probe",
});

export type BrowserDeviceStorageProbe = Readonly<{
  readonly durable: boolean;
}>;

/**
 * Preflights the default record store by writing a minimal probe record,
 * waiting for the transaction to commit, reading it back, and removing it.
 * Reports false when IndexedDB is unavailable, the write does not commit, or
 * the record cannot be read back, so callers can preflight durable storage
 * before creating a remote Device.
 */
export const probeBrowserDeviceStorage = async (
  options?: Readonly<{ readonly recordStore?: DeviceRecordStore }>,
): Promise<BrowserDeviceStorageProbe> => {
  const recordStore =
    options?.recordStore ??
    (indexedFactory() === undefined
      ? undefined
      : createIndexedDbDeviceRecordStore());
  if (!recordStore) return { durable: false };
  try {
    const scope = Object.freeze({
      pin: PROBE_PIN,
      deviceId: globalThis.crypto.getRandomValues(new Uint8Array(16)),
    });
    const probeRecord: EncryptedDeviceRecord = Object.freeze({
      version: 1,
      scope,
      iv: new Uint8Array(0),
      ciphertext: new Uint8Array(0),
    });
    await recordStore.write(probeRecord);
    const readBack = await recordStore.read(scope);
    if (!readBack) return { durable: false };
    await recordStore.remove(scope);
    return { durable: true };
  } catch {
    return { durable: false };
  }
};

export const createBrowserDeviceStorage = (
  pin: ServerProfilePin,
  options?: Readonly<{
    readonly recordStore?: DeviceRecordStore;
    readonly runtime?: Crypto;
    readonly diagnostics?: DiagnosticSink;
  }>,
): BrowserDeviceStorage => {
  const runtime = options?.runtime ?? globalThis.crypto;
  const defaultIndexedDb = indexedFactory() !== undefined;
  const recordStore =
    options?.recordStore ??
    (defaultIndexedDb
      ? createIndexedDbDeviceRecordStore()
      : createMemoryDeviceRecordStore());
  const emitDiagnostic = (
    eventName: "client.storage.load" | "client.storage.save",
    outcome: "success" | "failure",
  ) => {
    try {
      options?.diagnostics?.emit(
        createDiagnosticEvent({
          eventName,
          correlationId: createCorrelationId(),
          outcome,
        }),
      );
    } catch {
      // Diagnostic loss is intentionally non-blocking.
    }
  };
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
    durable: options?.recordStore === undefined && defaultIndexedDb,
    save: async (bundle) => {
      let plaintext: Uint8Array | undefined;
      try {
        if (
          bundle.pin.serverProfileId !== pin.serverProfileId ||
          bundle.pin.origin !== pin.origin
        )
          throw new Error(
            "device bundle origin or profile isolation violation",
          );
        const wrappingKey = await resolveWrappingKey();
        const associatedData = wrappingAssociatedData(pin, bundle.deviceId);
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
        emitDiagnostic("client.storage.save", "success");
      } catch (error) {
        emitDiagnostic("client.storage.save", "failure");
        throw error;
      } finally {
        zeroize(plaintext);
      }
    },
    load: async (scope) => {
      let plaintext: Uint8Array | undefined;
      try {
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
        plaintext = await unwrapBytes(
          wrappingKey,
          record.iv,
          record.ciphertext,
          associatedData,
          runtime,
        );
        const bundle = parseDevicePrivateBundle(plaintext, pin);
        emitDiagnostic("client.storage.load", "success");
        return bundle;
      } catch (error) {
        emitDiagnostic("client.storage.load", "failure");
        throw error;
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
