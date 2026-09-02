import type { ServerProfilePin } from "@dotrelay/contracts";

export type DeviceStorageScope = Readonly<{
  readonly pin: ServerProfilePin;
  readonly deviceId: Uint8Array;
}>;

export type EncryptedDeviceRecord = Readonly<{
  readonly version: 1;
  readonly scope: DeviceStorageScope;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly wrappingKey?: CryptoKey;
}>;

export type DeviceRecordStore = Readonly<{
  read(scope: DeviceStorageScope): Promise<EncryptedDeviceRecord | null>;
  write(record: EncryptedDeviceRecord): Promise<void>;
  remove(scope: DeviceStorageScope): Promise<void>;
  wipe?(pin: ServerProfilePin): Promise<void>;
}>;

export type CredentialStore = Readonly<{
  get(service: string, account: string): Promise<Uint8Array | null>;
  set(service: string, account: string, secret: Uint8Array): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}>;

export const scopeKey = (scope: DeviceStorageScope): string => {
  if (scope.deviceId.length !== 16)
    throw new TypeError("device id must be 16 bytes");
  const deviceHex = [...scope.deviceId]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${scope.pin.origin}\0${scope.pin.serverProfileId}\0${deviceHex}`;
};

export const credentialAccount = (scope: DeviceStorageScope): string =>
  scopeKey(scope);

export const DOTRELAY_CREDENTIAL_SERVICE = "dotrelay-device-wrap" as const;

export const zeroize = (value: Uint8Array | undefined): void => {
  value?.fill(0);
};
