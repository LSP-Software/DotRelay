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
import { createMemoryDeviceRecordStore } from "./browser";
import {
  type CredentialStore,
  credentialAccount,
  type DeviceRecordStore,
  type DeviceStorageScope,
  DOTRELAY_CREDENTIAL_SERVICE,
  legacyCredentialAccount,
  zeroize,
} from "./types";
import {
  exportWrappingKeyMaterial,
  importWrappingKeyMaterial,
  unwrapBytes,
  wrapBytes,
  wrappingAssociatedData,
} from "./wrapping";

export type CliDeviceStorage = Readonly<{
  save(bundle: DevicePrivateBundle): Promise<void>;
  load(scope: DeviceStorageScope): Promise<DevicePrivateBundle>;
  remove(scope: DeviceStorageScope): Promise<void>;
}>;

const secrets = new Map<string, Uint8Array>();

export const createMemoryCredentialStore = (): CredentialStore => {
  const key = (service: string, account: string) => `${service}\0${account}`;
  return Object.freeze({
    get: async (service, account) => {
      const value = secrets.get(key(service, account));
      return value ? new Uint8Array(value) : null;
    },
    set: async (service, account, secret) => {
      secrets.set(key(service, account), new Uint8Array(secret));
    },
    delete: async (service, account) => {
      secrets.delete(key(service, account));
    },
  });
};

export const resetMemoryCredentialStore = (): void => {
  secrets.clear();
};

const loadWrappingKey = async (
  scope: DeviceStorageScope,
  credentialStore: CredentialStore,
  runtime: Crypto,
): Promise<CryptoKey> => {
  let material = await credentialStore.get(
    DOTRELAY_CREDENTIAL_SERVICE,
    credentialAccount(scope),
  );
  if (!material) {
    try {
      material = await credentialStore.get(
        DOTRELAY_CREDENTIAL_SERVICE,
        legacyCredentialAccount(scope),
      );
    } catch {
      material = null;
    }
  }
  if (!material) throw new Error("cli wrapping secret is missing");
  try {
    if (
      !(await credentialStore.get(
        DOTRELAY_CREDENTIAL_SERVICE,
        credentialAccount(scope),
      ))
    )
      await credentialStore.set(
        DOTRELAY_CREDENTIAL_SERVICE,
        credentialAccount(scope),
        material,
      );
    await credentialStore
      .delete(DOTRELAY_CREDENTIAL_SERVICE, legacyCredentialAccount(scope))
      .catch(() => undefined);
    return await importWrappingKeyMaterial(material, false, runtime);
  } finally {
    zeroize(material);
  }
};

const ensureWrappingKey = async (
  scope: DeviceStorageScope,
  credentialStore: CredentialStore,
  runtime: Crypto,
): Promise<CryptoKey> => {
  const existing = await credentialStore.get(
    DOTRELAY_CREDENTIAL_SERVICE,
    credentialAccount(scope),
  );
  if (existing) {
    try {
      return await importWrappingKeyMaterial(existing, false, runtime);
    } finally {
      zeroize(existing);
    }
  }
  let legacy: Uint8Array | null = null;
  try {
    legacy = await credentialStore.get(
      DOTRELAY_CREDENTIAL_SERVICE,
      legacyCredentialAccount(scope),
    );
  } catch {
    legacy = null;
  }
  if (legacy) {
    try {
      await credentialStore.set(
        DOTRELAY_CREDENTIAL_SERVICE,
        credentialAccount(scope),
        legacy,
      );
      await credentialStore
        .delete(DOTRELAY_CREDENTIAL_SERVICE, legacyCredentialAccount(scope))
        .catch(() => undefined);
      return await importWrappingKeyMaterial(legacy, false, runtime);
    } finally {
      zeroize(legacy);
    }
  }
  const exportable = await runtime.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  let material: Uint8Array | undefined;
  try {
    material = await exportWrappingKeyMaterial(exportable, runtime);
    await credentialStore.set(
      DOTRELAY_CREDENTIAL_SERVICE,
      credentialAccount(scope),
      material,
    );
    return await importWrappingKeyMaterial(material, false, runtime);
  } finally {
    zeroize(material);
  }
};

export const createCliDeviceStorage = (
  pin: ServerProfilePin,
  credentialStore: CredentialStore,
  options?: Readonly<{
    readonly recordStore?: DeviceRecordStore;
    readonly runtime?: Crypto;
    readonly diagnostics?: DiagnosticSink;
  }>,
): CliDeviceStorage => {
  const runtime = options?.runtime ?? globalThis.crypto;
  const recordStore = options?.recordStore ?? createMemoryDeviceRecordStore();
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

  return Object.freeze({
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
        const scope = Object.freeze({ pin, deviceId: bundle.deviceId });
        const wrappingKey = await ensureWrappingKey(
          scope,
          credentialStore,
          runtime,
        );
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
            scope,
            iv: wrapped.iv,
            ciphertext: wrapped.ciphertext,
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
        const wrappingKey = await loadWrappingKey(
          scope,
          credentialStore,
          runtime,
        );
        const record = await recordStore.read(scope);
        if (!record) throw new Error("encrypted device bundle is missing");
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
      await credentialStore.delete(
        DOTRELAY_CREDENTIAL_SERVICE,
        credentialAccount(scope),
      );
      try {
        await credentialStore.delete(
          DOTRELAY_CREDENTIAL_SERVICE,
          legacyCredentialAccount(scope),
        );
      } catch {
        // Legacy accounts can be unaddressable on POSIX stores because their
        // original format contained a NUL separator.
      }
    },
  });
};
