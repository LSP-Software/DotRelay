const STORAGE_PROBE_KEY = "dotrelay.browser-storage-probe";

export const browserDeviceIdKey = (
  origin: string,
  serverProfileId: string,
): string => `dotrelay.browser-device:${origin}:${serverProfileId}`;

export const readStoredBrowserDeviceId = (
  origin: string,
  serverProfileId: string,
): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(
      browserDeviceIdKey(origin, serverProfileId),
    );
  } catch {
    return null;
  }
};

/**
 * Persists the Device id that lets a fresh page load find this browser's
 * Device. Throws when local storage is denied, exhausted, or otherwise unable
 * to keep the value, so callers can preflight and verify durable storage
 * instead of silently losing the id.
 */
export const writeStoredBrowserDeviceId = (
  origin: string,
  serverProfileId: string,
  deviceId: string,
): void => {
  if (typeof window === "undefined")
    throw new Error("browser local storage is unavailable");
  const key = browserDeviceIdKey(origin, serverProfileId);
  window.localStorage.setItem(key, deviceId);
  if (window.localStorage.getItem(key) !== deviceId)
    throw new Error("browser local storage could not keep the Device id");
};

export const probeBrowserLocalStorage = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(STORAGE_PROBE_KEY, "probe");
    const ok = window.localStorage.getItem(STORAGE_PROBE_KEY) === "probe";
    window.localStorage.removeItem(STORAGE_PROBE_KEY);
    return ok;
  } catch {
    return false;
  }
};

// The IndexedDB databases that hold this browser's Device keys and its
// Server Profile trust pins (see @dotrelay/client's browser storage).
const DOTRELAY_DATABASES = ["dotrelay-device", "dotrelay-profile-pins"];

const deleteDatabase = (factory: IDBFactory, name: string): Promise<void> =>
  new Promise((resolve) => {
    try {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // Another tab holding the database open delays deletion until it
      // closes; the sign-out navigation closes this tab's connections.
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });

/**
 * Removes everything this browser keeps for DotRelay: the sealed copy of the
 * Account Master Key, the Device keys and id, trust pins, and pending
 * publication journals. Signing out alone leaves them so the next sign-in
 * restores the same browser; on a shared computer, the next person who
 * signs in to the same GitHub account would get the unlocked account, so
 * "forget this browser" clears it all. The next sign-in enrolls a new
 * Device and needs a Recovery Code, a transfer, or a passkey to unlock.
 */
export const forgetThisBrowser = async (): Promise<void> => {
  if (typeof window !== "undefined") {
    try {
      const storage = window.localStorage;
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith("dotrelay.") || key?.startsWith("dotrelay-"))
          keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    } catch {
      // Storage is unavailable; there is nothing to clear.
    }
  }
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (factory)
    await Promise.all(
      DOTRELAY_DATABASES.map((name) => deleteDatabase(factory, name)),
    );
};
