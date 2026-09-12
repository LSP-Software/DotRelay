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
