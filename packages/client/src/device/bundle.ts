import {
  type CborValue,
  encodeProtocolObject,
  exportEncryptionPrivateKey,
  exportSigningPrivateKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  importEncryptionPrivateKey,
  importSigningPrivateKey,
  type ProtocolObject,
  parseProtocolObject,
  protocolObjectFromFields,
  type ServerProfilePin,
} from "@dotrelay/contracts";

export type DevicePrivateBundle = Readonly<{
  readonly object: ProtocolObject;
  readonly pin: ServerProfilePin;
  readonly userId: Uint8Array;
  readonly deviceId: Uint8Array;
  readonly userIdentityGeneration: number;
}>;

export type DeviceKeyMaterial = Readonly<{
  readonly encryptionPrivateKey: CryptoKey;
  readonly signingPrivateKey: CryptoKey;
}>;

const requireLength = (
  value: Uint8Array,
  length: number,
  name: string,
): void => {
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new TypeError(`${name} must be ${length} bytes`);
};

export const createDevicePrivateBundle = async (
  input: Readonly<{
    readonly pin: ServerProfilePin;
    readonly userId: Uint8Array;
    readonly deviceId: Uint8Array;
    readonly userIdentityGeneration: number;
  }>,
): Promise<DevicePrivateBundle> => {
  requireLength(input.userId, 16, "user id");
  requireLength(input.deviceId, 16, "device id");
  if (
    !Number.isSafeInteger(input.userIdentityGeneration) ||
    input.userIdentityGeneration < 0
  )
    throw new TypeError("user identity generation must be a safe integer");
  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const fields = new Map<number, CborValue>();
  fields.set(8, uuidToBytes(input.pin.serverProfileId));
  fields.set(9, input.userId);
  fields.set(10, input.deviceId);
  fields.set(28, input.userIdentityGeneration);
  fields.set(80, await exportEncryptionPrivateKey(encryption.privateKey));
  fields.set(81, await exportSigningPrivateKey(signing.privateKey));
  const object = protocolObjectFromFields(18, fields);
  return Object.freeze({
    object,
    pin: input.pin,
    userId: input.userId,
    deviceId: input.deviceId,
    userIdentityGeneration: input.userIdentityGeneration,
  });
};

export const encodeDevicePrivateBundle = (
  bundle: DevicePrivateBundle,
): Uint8Array => encodeProtocolObject(bundle.object);

export const parseDevicePrivateBundle = (
  bytes: Uint8Array,
  expectedPin: ServerProfilePin,
): DevicePrivateBundle => {
  const object = parseProtocolObject(bytes);
  if (object.get(1) !== 18)
    throw new TypeError("expected device private bundle");
  const serverProfileId = bytesToUuid(requireField(object, 8, 16));
  const userId = requireField(object, 9, 16);
  const deviceId = requireField(object, 10, 16);
  const userIdentityGeneration = object.get(28);
  if (
    typeof userIdentityGeneration !== "number" ||
    !Number.isSafeInteger(userIdentityGeneration)
  )
    throw new TypeError("invalid user identity generation");
  if (
    serverProfileId !== expectedPin.serverProfileId ||
    expectedPin.origin.length === 0
  )
    throw new Error("device bundle server profile mismatch");
  return Object.freeze({
    object,
    pin: expectedPin,
    userId,
    deviceId,
    userIdentityGeneration,
  });
};

export const loadDeviceKeyMaterial = async (
  bundle: DevicePrivateBundle,
): Promise<DeviceKeyMaterial> => {
  const encryptionBytes = requireField(bundle.object, 80);
  const signingBytes = requireField(bundle.object, 81);
  return Object.freeze({
    encryptionPrivateKey: await importEncryptionPrivateKey(encryptionBytes),
    signingPrivateKey: await importSigningPrivateKey(signingBytes),
  });
};

const requireField = (
  object: ProtocolObject,
  field: number,
  length?: number,
): Uint8Array => {
  const value = object.get(field);
  if (!(value instanceof Uint8Array))
    throw new TypeError(`field ${field} must be bytes`);
  if (length !== undefined && value.length !== length)
    throw new TypeError(`field ${field} must be ${length} bytes`);
  return value;
};

const uuidToBytes = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized))
    throw new TypeError("server profile id must be a UUID");
  const output = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1)
    output[index] = Number.parseInt(
      normalized.slice(index * 2, index * 2 + 2),
      16,
    );
  return output;
};

const bytesToUuid = (value: Uint8Array): string => {
  requireLength(value, 16, "uuid bytes");
  const hex = [...value]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
