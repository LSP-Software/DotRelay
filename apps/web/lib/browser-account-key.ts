import {
  createBrowserDeviceStorage,
  loadDeviceKeyMaterial,
  open,
  seal,
  uuidToBytes,
} from "@dotrelay/client";
import type { WorkspaceBoundary } from "./workspace-boundary";

// The browser's existing, durable Device key protects a local copy of the
// Account Master Key. The service never receives this copy. Binding the
// ciphertext to the account, server, Device, and active recovery wrapper
// prevents an old browser profile from silently opening a different account.
const cacheKey = (boundary: WorkspaceBoundary): string =>
  `dotrelay.account-key:v1:${boundary.profile.origin}:${boundary.profile.serverProfileId}:${boundary.session.userId}:${boundary.device.id}`;

const associatedData = (boundary: WorkspaceBoundary, wrapperId: string) =>
  new TextEncoder().encode(`${cacheKey(boundary)}:${wrapperId}`);

const deviceKeys = async (boundary: WorkspaceBoundary) => {
  const { serverProfileId, origin } = boundary.profile;
  const deviceId = boundary.device.id;
  if (!serverProfileId || !deviceId || !boundary.session.userId)
    throw new Error("No account device is available");
  const pin = { serverProfileId, origin };
  const storage = createBrowserDeviceStorage(pin);
  if (!storage.durable) throw new Error("Device storage is not durable");
  const bundle = await storage.load({ pin, deviceId: uuidToBytes(deviceId) });
  if (
    [...bundle.userId]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("") !== boundary.session.userId.replaceAll("-", "").toLowerCase()
  )
    throw new Error("Device belongs to another account");
  return loadDeviceKeyMaterial(bundle);
};

export const saveBrowserAccountKey = async (
  boundary: WorkspaceBoundary,
  wrapperId: string,
  accountMasterKey: Uint8Array,
): Promise<void> => {
  if (accountMasterKey.length !== 32) throw new Error("Invalid account key");
  const keys = await deviceKeys(boundary);
  if (!keys.encryptionPublicKey)
    throw new Error("Device public key is missing");
  const ciphertext = await seal(
    accountMasterKey,
    keys.encryptionPublicKey,
    associatedData(boundary, wrapperId),
  );
  const value = btoa(String.fromCharCode(...ciphertext));
  window.localStorage.setItem(cacheKey(boundary), value);
  if (window.localStorage.getItem(cacheKey(boundary)) !== value)
    throw new Error("Browser could not save the account key");
};

export const restoreBrowserAccountKey = async (
  boundary: WorkspaceBoundary,
  wrapperId: string,
): Promise<Uint8Array | null> => {
  try {
    const encoded = window.localStorage.getItem(cacheKey(boundary));
    if (!encoded) return null;
    const keys = await deviceKeys(boundary);
    const ciphertext = Uint8Array.from(atob(encoded), (char) =>
      char.charCodeAt(0),
    );
    const key = await open(
      ciphertext,
      keys.encryptionPrivateKey,
      associatedData(boundary, wrapperId),
    );
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
};
