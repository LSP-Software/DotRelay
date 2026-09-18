import type { ServerProfilePin } from "@dotrelay/contracts";

/**
 * A record backend for Server Profile trust pins. A pin is the verified
 * decision that one browser trusts the service at `pin.origin` with the
 * stable identity `pin.serverProfileId`; it is keyed by that pair, so a pin
 * can never apply to a different origin or a different identity.
 */
export type ProfilePinRecordStore = Readonly<{
  readonly read: (key: string) => Promise<boolean>;
  readonly write: (key: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}>;

export type BrowserProfilePinStore = Readonly<{
  /**
   * True only when pins are held by IndexedDB and therefore survive a page
   * reload. A memory-only fallback can serve this page load but cannot be
   * claimed as a durable trust decision.
   */
  readonly durable: boolean;
  readonly has: (pin: ServerProfilePin) => Promise<boolean>;
  readonly set: (pin: ServerProfilePin) => Promise<void>;
  readonly remove: (pin: ServerProfilePin) => Promise<void>;
}>;

export const profilePinKey = (pin: ServerProfilePin): string =>
  `pin\0${pin.origin}\0${pin.serverProfileId}`;

type IndexedRequest<T> = {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
};
type IndexedStore = {
  get(key: string): IndexedRequest<unknown>;
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

const PIN_RECORD_KEY = "key";

const createIndexedDbProfilePinStore = (): ProfilePinRecordStore => {
  const openDatabase = (): Promise<IndexedDatabase> =>
    new Promise((resolve, reject) => {
      const factory = indexedFactory();
      if (!factory) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = factory.open("dotrelay-profile-pins", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("pins", { keyPath: PIN_RECORD_KEY });
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
      const transaction = database.transaction("pins", mode);
      const request = callback(transaction.objectStore("pins"));
      let result: T | undefined;
      let hasResult = false;
      let settled = false;
      // A request succeeding only means the operation ran inside the
      // transaction; the pin is durable only once the transaction commits.
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
      request.onerror = () =>
        settle(() =>
          reject(
            request.error instanceof Error
              ? request.error
              : new Error("IndexedDB request failed"),
          ),
        );
      transaction.oncomplete = () =>
        settle(() => resolve(hasResult ? (result as T) : (undefined as T)));
      transaction.onerror = () =>
        settle(() =>
          reject(
            transaction.error instanceof Error
              ? transaction.error
              : new Error("IndexedDB transaction failed"),
          ),
        );
      transaction.onabort = () =>
        settle(() =>
          reject(
            transaction.error instanceof Error
              ? transaction.error
              : new Error("IndexedDB transaction aborted"),
          ),
        );
    });
  };
  return Object.freeze({
    read: async (key) =>
      (await transact<unknown>("readonly", (store) => store.get(key))) !==
      undefined,
    write: async (key) => {
      await transact<unknown>("readwrite", (store) =>
        store.put({ [PIN_RECORD_KEY]: key }),
      );
    },
    remove: async (key) => {
      await transact<unknown>("readwrite", (store) => store.delete(key));
    },
  });
};

const memoryPins = new Set<string>();

const createMemoryProfilePinStore = (): ProfilePinRecordStore =>
  Object.freeze({
    read: async (key) => memoryPins.has(key),
    write: async (key) => {
      memoryPins.add(key);
    },
    remove: async (key) => {
      memoryPins.delete(key);
    },
  });

export const resetMemoryProfilePinStore = (): void => {
  memoryPins.clear();
};

export const createBrowserProfilePinStore = (
  options?: Readonly<{ readonly recordStore?: ProfilePinRecordStore }>,
): BrowserProfilePinStore => {
  const defaultIndexedDb = indexedFactory() !== undefined;
  const recordStore =
    options?.recordStore ??
    (defaultIndexedDb
      ? createIndexedDbProfilePinStore()
      : createMemoryProfilePinStore());
  return Object.freeze({
    durable: options?.recordStore === undefined && defaultIndexedDb,
    has: async (pin) => recordStore.read(profilePinKey(pin)),
    set: async (pin) => {
      await recordStore.write(profilePinKey(pin));
      // Verify from a fresh read that the pin is kept before the trust
      // decision is claimed; a write that silently drops is not a pin.
      if (!(await recordStore.read(profilePinKey(pin))))
        throw new Error("profile pin could not be kept");
    },
    remove: async (pin) => {
      await recordStore.remove(profilePinKey(pin));
    },
  });
};
