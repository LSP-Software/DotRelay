import {
  type CborValue,
  canonicalEncode,
  encodeProtocolObject,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  protocolObjectFromFields,
  SUITE_NAME,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  createDevicePrivateBundle,
  type DeviceKeyMaterial,
  type DevicePrivateBundle,
} from "./bundle";

export type DeviceBootstrap = Readonly<{
  readonly bundle: DevicePrivateBundle;
  readonly keyMaterial: DeviceKeyMaterial;
  readonly deviceId: string;
  readonly identityGeneration: number;
  readonly keyId: Uint8Array;
  readonly x25519PublicKey: Uint8Array;
  readonly ed25519PublicKey: Uint8Array;
  readonly certificate: Readonly<{
    readonly id: string;
    readonly suite: typeof SUITE_NAME;
    readonly formatVersion: 3;
    readonly kind: 2;
    readonly canonicalBytes: Uint8Array;
    readonly digest: Uint8Array;
  }>;
}>;

const rawPublicKey = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key)).slice(0, 32);

export const createDeviceBootstrap = async (
  input: Readonly<{
    readonly pin: Readonly<{ serverProfileId: string; origin: string }>;
    readonly userId: string;
    readonly userIdentityGeneration?: number;
    readonly deviceId?: string;
  }>,
): Promise<DeviceBootstrap> => {
  const identityGeneration = input.userIdentityGeneration ?? 1;
  const deviceId = input.deviceId ?? crypto.randomUUID();
  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const x25519PublicKey = await rawPublicKey(encryption.publicKey);
  const ed25519PublicKey = await rawPublicKey(signing.publicKey);
  const keyMaterial: DeviceKeyMaterial = Object.freeze({
    encryptionPrivateKey: encryption.privateKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    signingPublicKey: signing.publicKey,
  });
  const bundle = await createDevicePrivateBundle({
    pin: input.pin,
    userId: uuidToBytes(input.userId),
    deviceId: uuidToBytes(deviceId),
    userIdentityGeneration: identityGeneration,
    keyMaterial,
    encryptionPublicKey: await exportSpki(encryption.publicKey),
    signingPublicKey: await exportSpki(signing.publicKey),
  });
  const certificateId = crypto.randomUUID();
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.pin.serverProfileId)],
    [9, uuidToBytes(input.userId)],
    [10, uuidToBytes(deviceId)],
    [17, uuidToBytes(crypto.randomUUID())],
    [28, identityGeneration],
    [32, Date.now()],
    [39, x25519PublicKey],
    [41, ed25519PublicKey],
    [79, 2],
  ]);
  const unsigned = protocolObjectFromFields(2, fields);
  const signedFields = new Map<number, CborValue>([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  const signature = await signProtocolObject(
    protocolObjectFromFields(2, signedFields),
    signing.privateKey,
  );
  signedFields.set(4, signature);
  const certificateBytes = encodeProtocolObject(
    protocolObjectFromFields(2, signedFields),
  );
  return Object.freeze({
    bundle,
    keyMaterial,
    deviceId,
    identityGeneration,
    keyId: await sha384(x25519PublicKey),
    x25519PublicKey,
    ed25519PublicKey,
    certificate: Object.freeze({
      id: certificateId,
      suite: SUITE_NAME,
      formatVersion: 3,
      kind: 2,
      canonicalBytes: certificateBytes,
      digest: await sha384(certificateBytes),
    }),
  });
};

const exportSpki = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("spki", key));
