import {
  bytesToUuid,
  type CborValue,
  canonicalEncode,
  encodeProtocolObject,
  exportEncryptionPublicKey,
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  protocolObjectFromFields,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  ProtocolVerificationError,
  verifySignedProtocolObject,
} from "../trust/verify";
import {
  createDevicePrivateBundle,
  type DeviceKeyMaterial,
  type DevicePrivateBundle,
} from "./bundle";

type EnrollmentIds = Readonly<{
  readonly serverProfileId: string;
  readonly userId: string;
  readonly enrollmentId: string;
  readonly deviceId: string;
  readonly initiatorDeviceId: string;
}>;

export type DeviceEnrollmentRequest = Readonly<{
  readonly ids: EnrollmentIds;
  readonly challenge: Uint8Array;
  readonly expiresAtMs: number;
  readonly transcriptBytes: Uint8Array;
  readonly transcriptHash: Uint8Array;
  readonly bundle: DevicePrivateBundle;
  readonly keyMaterial: DeviceKeyMaterial;
  readonly initiatorSigningPublicKey: Uint8Array;
  readonly certificateBytes: Uint8Array;
}>;

export type DeviceEnrollmentApproval = Readonly<{
  readonly enrollmentId: string;
  readonly initiatorDeviceId: string;
  readonly enrolledDeviceId: string;
  readonly approverDeviceId: string;
  readonly transcriptHash: Uint8Array;
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
}>;

export type DeviceEnrollmentTranscript = Readonly<{
  readonly serverProfileId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly enrollmentId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly challenge: Uint8Array;
  readonly encryptionPublicKey: Uint8Array;
  readonly signingPublicKey: Uint8Array;
}>;

const bytes = (
  value: CborValue | undefined,
  field: string,
  length: number,
): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new ProtocolVerificationError(`${field} is malformed`);
  return value;
};

const equal = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const signedBytes = async (
  kind: number,
  fields: ReadonlyMap<number, CborValue>,
  privateKey: CryptoKey,
): Promise<Uint8Array> => {
  const unsigned = protocolObjectFromFields(kind, fields);
  const signedFields = new Map<number, CborValue>([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  signedFields.set(
    4,
    await signProtocolObject(
      protocolObjectFromFields(kind, signedFields),
      privateKey,
    ),
  );
  return encodeProtocolObject(protocolObjectFromFields(kind, signedFields));
};

const rawPublicKey = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key));

const validateExpiry = (expiresAtMs: number): void => {
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now())
    throw new TypeError("enrollment expiry must be a future safe integer");
};

export const createDeviceCertificate = async (
  input: Readonly<{
    readonly serverProfileId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly identityGeneration: number;
    readonly encryptionPublicKey: Uint8Array;
    readonly signingPublicKey: Uint8Array;
    readonly signingPrivateKey: CryptoKey;
    readonly createdAtMs?: number;
  }>,
): Promise<Uint8Array> => {
  if (
    input.encryptionPublicKey.length !== 32 ||
    input.signingPublicKey.length !== 32
  )
    throw new TypeError("Device public keys must be 32 bytes");
  if (
    !Number.isSafeInteger(input.identityGeneration) ||
    input.identityGeneration < 0
  )
    throw new TypeError("identity generation must be a safe integer");
  return signedBytes(
    2,
    new Map<number, CborValue>([
      [8, uuidToBytes(input.serverProfileId)],
      [9, uuidToBytes(input.userId)],
      [10, uuidToBytes(input.deviceId)],
      [17, uuidToBytes(crypto.randomUUID())],
      [28, input.identityGeneration],
      [32, input.createdAtMs ?? Date.now()],
      [39, new Uint8Array(input.encryptionPublicKey)],
      [41, new Uint8Array(input.signingPublicKey)],
      [79, 2],
    ]),
    input.signingPrivateKey,
  );
};

export const parseDeviceEnrollmentTranscript = async (
  bytesToParse: Uint8Array,
  initiatorSigningPublicKey: Uint8Array,
): Promise<DeviceEnrollmentTranscript> => {
  const object = await verifySignedProtocolObject(
    bytesToParse,
    initiatorSigningPublicKey,
  );
  if (object.get(1) !== 4)
    throw new ProtocolVerificationError("expected enrollment transcript");
  return Object.freeze({
    serverProfileId: bytesToUuid(bytes(object.get(8), "server profile id", 16)),
    userId: bytesToUuid(bytes(object.get(9), "user id", 16)),
    deviceId: bytesToUuid(bytes(object.get(10), "device id", 16)),
    enrollmentId: bytesToUuid(bytes(object.get(17), "enrollment id", 16)),
    createdAtMs: requireSafeNumber(object.get(32), "created-at"),
    expiresAtMs: requireSafeNumber(object.get(33), "expires-at"),
    challenge: new Uint8Array(bytes(object.get(57), "challenge", 32)),
    encryptionPublicKey: new Uint8Array(
      bytes(object.get(39), "encryption public key", 32),
    ),
    signingPublicKey: new Uint8Array(
      bytes(object.get(41), "signing public key", 32),
    ),
  });
};

const requireSafeNumber = (
  value: CborValue | undefined,
  field: string,
): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ProtocolVerificationError(`${field} is malformed`);
  return value;
};

export const createDeviceEnrollmentRequest = async (
  input: Readonly<{
    readonly serverProfileId: string;
    readonly origin: string;
    readonly userId: string;
    readonly identityGeneration: number;
    readonly initiatorDeviceId: string;
    readonly initiatorSigningPrivateKey: CryptoKey;
    readonly initiatorSigningPublicKey: Uint8Array;
    readonly expiresAtMs: number;
    readonly deviceId?: string;
  }>,
): Promise<DeviceEnrollmentRequest> => {
  validateExpiry(input.expiresAtMs);
  if (input.initiatorSigningPublicKey.length === 0)
    throw new TypeError("initiator signing public key is required");
  const deviceId = input.deviceId ?? crypto.randomUUID();
  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const keyMaterial: DeviceKeyMaterial = Object.freeze({
    encryptionPrivateKey: encryption.privateKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    signingPublicKey: signing.publicKey,
  });
  const bundle = await createDevicePrivateBundle({
    pin: { serverProfileId: input.serverProfileId, origin: input.origin },
    userId: uuidToBytes(input.userId),
    deviceId: uuidToBytes(deviceId),
    userIdentityGeneration: input.identityGeneration,
    keyMaterial,
    encryptionPublicKey: await exportEncryptionPublicKey(encryption.publicKey),
    signingPublicKey: await exportSigningPublicKey(signing.publicKey),
  });
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const enrollmentId = crypto.randomUUID();
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.serverProfileId)],
    [9, uuidToBytes(input.userId)],
    [10, uuidToBytes(deviceId)],
    [17, uuidToBytes(enrollmentId)],
    [32, Date.now()],
    [33, input.expiresAtMs],
    [39, await rawPublicKey(encryption.publicKey)],
    [41, await rawPublicKey(signing.publicKey)],
    [57, challenge],
  ]);
  const transcriptBytes = await signedBytes(
    4,
    fields,
    input.initiatorSigningPrivateKey,
  );
  const certificateBytes = await createDeviceCertificate({
    serverProfileId: input.serverProfileId,
    userId: input.userId,
    deviceId,
    identityGeneration: input.identityGeneration,
    encryptionPublicKey: await rawPublicKey(encryption.publicKey),
    signingPublicKey: await rawPublicKey(signing.publicKey),
    signingPrivateKey: signing.privateKey,
  });
  return Object.freeze({
    ids: Object.freeze({
      serverProfileId: input.serverProfileId,
      userId: input.userId,
      enrollmentId,
      deviceId,
      initiatorDeviceId: input.initiatorDeviceId,
    }),
    challenge,
    expiresAtMs: input.expiresAtMs,
    transcriptBytes,
    transcriptHash: await sha384(transcriptBytes),
    bundle,
    keyMaterial,
    initiatorSigningPublicKey: new Uint8Array(input.initiatorSigningPublicKey),
    certificateBytes,
  });
};

export const createDeviceEnrollmentApproval = async (
  input: Readonly<{
    readonly request: DeviceEnrollmentRequest;
    readonly approverDeviceId: string;
    readonly approverSigningPrivateKey: CryptoKey;
    readonly createdAtMs?: number;
  }>,
): Promise<DeviceEnrollmentApproval> => {
  const transcript = await parseDeviceEnrollmentTranscript(
    input.request.transcriptBytes,
    input.request.initiatorSigningPublicKey,
  );
  if (transcript.enrollmentId !== input.request.ids.enrollmentId)
    throw new ProtocolVerificationError("enrollment request id mismatch");
  if (input.approverDeviceId === input.request.ids.initiatorDeviceId)
    throw new TypeError("enrollment approver must differ from initiator");
  const transcriptHash = await sha384(input.request.transcriptBytes);
  if (!equal(transcriptHash, input.request.transcriptHash))
    throw new ProtocolVerificationError("enrollment transcript hash mismatch");
  const createdAtMs = input.createdAtMs ?? Date.now();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0)
    throw new TypeError("approval time must be a safe integer");
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.request.ids.serverProfileId)],
    [9, uuidToBytes(input.request.ids.userId)],
    [10, uuidToBytes(input.request.ids.deviceId)],
    [17, uuidToBytes(input.request.ids.enrollmentId)],
    [32, createdAtMs],
    [76, transcriptHash],
    [77, uuidToBytes(input.approverDeviceId)],
  ]);
  const canonicalBytes = await signedBytes(
    5,
    fields,
    input.approverSigningPrivateKey,
  );
  return Object.freeze({
    enrollmentId: input.request.ids.enrollmentId,
    initiatorDeviceId: input.request.ids.initiatorDeviceId,
    enrolledDeviceId: input.request.ids.deviceId,
    approverDeviceId: input.approverDeviceId,
    transcriptHash: new Uint8Array(transcriptHash),
    canonicalBytes,
    digest: await sha384(canonicalBytes),
  });
};

export const verifyDeviceEnrollmentApproval = async (
  approvalBytes: Uint8Array,
  input: Readonly<{
    readonly transcriptBytes: Uint8Array;
    readonly serverProfileId: string;
    readonly userId: string;
    readonly enrolledDeviceId: string;
    readonly initiatorDeviceId: string;
    readonly approverDeviceId: string;
    readonly initiatorSigningPublicKey: Uint8Array;
    readonly approverSigningPublicKey: Uint8Array;
  }>,
): Promise<DeviceEnrollmentApproval> => {
  const transcript = await parseDeviceEnrollmentTranscript(
    input.transcriptBytes,
    input.initiatorSigningPublicKey,
  );
  const object = await verifySignedProtocolObject(
    approvalBytes,
    input.approverSigningPublicKey,
  );
  if (object.get(1) !== 5)
    throw new ProtocolVerificationError("expected enrollment approval");
  const expectedHash = await sha384(input.transcriptBytes);
  if (
    !equal(
      bytes(object.get(8), "server profile id", 16),
      uuidToBytes(input.serverProfileId),
    ) ||
    !equal(bytes(object.get(9), "user id", 16), uuidToBytes(input.userId)) ||
    !equal(
      bytes(object.get(10), "device id", 16),
      uuidToBytes(input.enrolledDeviceId),
    ) ||
    !equal(
      bytes(object.get(17), "enrollment id", 16),
      uuidToBytes(transcript.enrollmentId),
    ) ||
    !equal(bytes(object.get(76), "transcript hash", 48), expectedHash) ||
    !equal(
      bytes(object.get(77), "approval device id", 16),
      uuidToBytes(input.approverDeviceId),
    ) ||
    input.approverDeviceId === input.initiatorDeviceId
  )
    throw new ProtocolVerificationError("enrollment approval binding mismatch");
  return Object.freeze({
    enrollmentId: bytesToUuid(bytes(object.get(17), "enrollment id", 16)),
    initiatorDeviceId: input.initiatorDeviceId,
    enrolledDeviceId: input.enrolledDeviceId,
    approverDeviceId: input.approverDeviceId,
    transcriptHash: new Uint8Array(expectedHash),
    canonicalBytes: new Uint8Array(approvalBytes),
    digest: await sha384(approvalBytes),
  });
};
