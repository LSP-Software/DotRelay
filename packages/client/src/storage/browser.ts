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

export const createMemoryDeviceRecordStore = (): DeviceRecordStore =>
  Object.freeze({
    read: async (scope) => records.get(scopeKey(scope)) ?? null,
    write: async (record) => {
      records.set(scopeKey(record.scope), record);
    },
    remove: async (scope) => {
      records.delete(scopeKey(scope));
    },
  });

export const createBrowserDeviceStorage = (
  pin: ServerProfilePin,
  options?: Readonly<{
    readonly recordStore?: DeviceRecordStore;
    readonly runtime?: Crypto;
  }>,
): BrowserDeviceStorage => {
  const runtime = options?.runtime ?? globalThis.crypto;
  const recordStore = options?.recordStore ?? createMemoryDeviceRecordStore();
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
      const wrappingKey = await resolveWrappingKey();
      const record = await recordStore.read(scope);
      if (!record) throw new Error("encrypted device bundle is missing");
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
      for (const key of [...records.keys()]) {
        if (key.startsWith(`${pin.origin}\0${pin.serverProfileId}\0`))
          records.delete(key);
      }
    },
  });
};

export const resetMemoryDeviceRecordStore = (): void => {
  records.clear();
  wrappingKeys.clear();
};
