import {
  bytesToUuid,
  type CborValue,
  canonicalDecode,
  canonicalEncode,
  decodeCiphertextEnvelope,
  encodeProtocolObject,
  exportEncryptionPrivateKey,
  exportEncryptionPublicKey,
  exportSigningPrivateKey,
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  importEncryptionPrivateKey,
  importSigningPrivateKey,
  open,
  parseProtocolObject,
  protocolObjectFromFields,
  seal,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  ProtocolVerificationError,
  verifySignedProtocolObject,
} from "../trust/verify";

const KIT_FORMAT = 1;
const KIT_FIELDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export type RecoveryKit = Readonly<{
  readonly bytes: Uint8Array;
  readonly envelopeBytes: Uint8Array;
  readonly envelopeId: string;
  readonly recoveryGeneration: number;
  readonly identityGeneration: number;
  readonly replacementDeviceId: string;
  readonly replacementEncryptionPrivateKey: CryptoKey;
  readonly replacementSigningPrivateKey: CryptoKey;
}>;

export type OpenedRecoveryKit = Readonly<{
  readonly envelope: ReadonlyMap<number, CborValue>;
  readonly envelopeBytes: Uint8Array;
  readonly envelopeId: string;
  readonly userId: string;
  readonly identityGeneration: number;
  readonly recoveryGeneration: number;
  readonly replacementDeviceId: string;
  readonly replacementEncryptionPrivateKey: CryptoKey;
  readonly replacementSigningPrivateKey: CryptoKey;
  readonly recoveryEncryptionPrivateKey: CryptoKey;
  readonly recoverySigningPrivateKey: CryptoKey;
}>;

export type RecoveredDeviceCertificate = Readonly<{
  readonly deviceId: string;
  readonly identityGeneration: number;
  readonly keyId: Uint8Array;
  readonly x25519PublicKey: Uint8Array;
  readonly ed25519PublicKey: Uint8Array;
  readonly certificateId: string;
  readonly certificateBytes: Uint8Array;
}>;

export type RecoveryChallengeProof = Readonly<{
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
  readonly challengeHash: Uint8Array;
}>;

const requireBytes = (
  value: CborValue | undefined,
  name: string,
  length?: number,
): Uint8Array => {
  if (
    !(value instanceof Uint8Array) ||
    (length !== undefined && value.length !== length)
  )
    throw new ProtocolVerificationError(`${name} is malformed`);
  return value;
};

const requireNumber = (value: CborValue | undefined, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ProtocolVerificationError(`${name} is malformed`);
  return value;
};

const recoveryAssociatedData = (
  serverProfileId: string,
  userId: string,
  envelopeId: string,
  replacementDeviceId: string,
  identityGeneration: number,
  recoveryGeneration: number,
): Uint8Array =>
  canonicalEncode(
    new Map<number, CborValue>([
      [0, 3],
      [1, 10],
      [8, uuidToBytes(serverProfileId)],
      [9, uuidToBytes(userId)],
      [17, uuidToBytes(envelopeId)],
      [18, uuidToBytes(replacementDeviceId)],
      [28, identityGeneration],
      [29, recoveryGeneration],
    ]),
  );

const signedBytes = async (
  fields: ReadonlyMap<number, CborValue>,
  privateKey: CryptoKey,
): Promise<Uint8Array> => {
  const unsigned = protocolObjectFromFields(10, fields);
  const signedFields = new Map<number, CborValue>([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  signedFields.set(
    4,
    await signProtocolObject(
      protocolObjectFromFields(10, signedFields),
      privateKey,
    ),
  );
  return encodeProtocolObject(protocolObjectFromFields(10, signedFields));
};

const encodeKit = (fields: ReadonlyMap<number, CborValue>): Uint8Array =>
  canonicalEncode(fields);

const parseKit = (encoded: Uint8Array): ReadonlyMap<number, CborValue> => {
  try {
    const value = canonicalDecode(encoded);
    if (!(value instanceof Map) || value.size !== KIT_FIELDS.length)
      throw new Error();
    if (KIT_FIELDS.some((field) => !value.has(field))) throw new Error();
    if (value.get(0) !== 3 || value.get(1) !== KIT_FORMAT) throw new Error();
    if (
      ![...value.keys()].every((field) =>
        KIT_FIELDS.includes(field as (typeof KIT_FIELDS)[number]),
      )
    )
      throw new Error();
    if (
      ![...value.values()].every(
        (item) => item instanceof Uint8Array || typeof item === "number",
      )
    )
      throw new Error();
    if (!equal(canonicalEncode(value), encoded)) throw new Error();
    return value;
  } catch {
    throw new ProtocolVerificationError("Recovery Kit is malformed");
  }
};

const equal = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const rawPublicKey = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key));

export const createRecoveryKit = async (
  input: Readonly<{
    readonly serverProfileId: string;
    readonly userId: string;
    readonly identityGeneration: number;
    readonly recoveryGeneration: number;
    readonly replacementDeviceId?: string;
    readonly activeDeviceSigningPrivateKey: CryptoKey;
  }>,
): Promise<RecoveryKit> => {
  if (
    !Number.isSafeInteger(input.identityGeneration) ||
    input.identityGeneration < 0
  )
    throw new TypeError("identity generation must be a safe integer");
  if (
    !Number.isSafeInteger(input.recoveryGeneration) ||
    input.recoveryGeneration < 1
  )
    throw new TypeError("recovery generation must be a positive safe integer");
  const replacementDeviceId = input.replacementDeviceId ?? crypto.randomUUID();
  const replacementEncryption = await generateEncryptionKeyPair();
  const replacementSigning = await generateSigningKeyPair();
  const recoveryEncryption = await generateEncryptionKeyPair();
  const recoverySigning = await generateSigningKeyPair();
  const envelopeId = crypto.randomUUID();
  const recoveryBundle = protocolObjectFromFields(
    11,
    new Map<number, CborValue>([
      [8, uuidToBytes(input.serverProfileId)],
      [9, uuidToBytes(input.userId)],
      [28, input.identityGeneration],
      [29, input.recoveryGeneration],
      [80, await exportEncryptionPrivateKey(replacementEncryption.privateKey)],
      [81, await exportSigningPrivateKey(replacementSigning.privateKey)],
    ]),
  );
  const recoveryBundleBytes = encodeProtocolObject(recoveryBundle);
  const associatedData = recoveryAssociatedData(
    input.serverProfileId,
    input.userId,
    envelopeId,
    replacementDeviceId,
    input.identityGeneration,
    input.recoveryGeneration,
  );
  const sealed = await seal(
    recoveryBundleBytes,
    recoveryEncryption.publicKey,
    associatedData,
  );
  const envelope = decodeCiphertextEnvelope(sealed);
  const recoveryFields = new Map<number, CborValue>([
    [8, uuidToBytes(input.serverProfileId)],
    [9, uuidToBytes(input.userId)],
    [17, uuidToBytes(envelopeId)],
    [28, input.identityGeneration],
    [29, input.recoveryGeneration],
    [32, Date.now()],
    [39, await rawPublicKey(recoveryEncryption.publicKey)],
    [41, await rawPublicKey(recoverySigning.publicKey)],
    [44, requireBytes(envelope.get(44), "salt", 32)],
    [45, requireBytes(envelope.get(45), "ephemeral key", 32)],
    [46, requireBytes(envelope.get(46), "iv", 12)],
    [47, requireBytes(envelope.get(47), "ciphertext")],
    [48, requireBytes(envelope.get(48), "ciphertext hash", 48)],
    [59, uuidToBytes(envelopeId)],
    [71, requireNumber(envelope.get(71), "plaintext length")],
    [72, requireNumber(envelope.get(72), "ciphertext length")],
  ]);
  const envelopeBytes = await signedBytes(
    recoveryFields,
    input.activeDeviceSigningPrivateKey,
  );
  const kitFields = new Map<number, CborValue>([
    [0, 3],
    [1, KIT_FORMAT],
    [2, envelopeBytes],
    [3, await exportEncryptionPrivateKey(recoveryEncryption.privateKey)],
    [4, await exportSigningPrivateKey(recoverySigning.privateKey)],
    [5, uuidToBytes(input.serverProfileId)],
    [6, uuidToBytes(input.userId)],
    [7, uuidToBytes(envelopeId)],
    [8, input.identityGeneration],
    [9, input.recoveryGeneration],
    [10, uuidToBytes(replacementDeviceId)],
  ]);
  return Object.freeze({
    bytes: encodeKit(kitFields),
    envelopeBytes,
    envelopeId,
    recoveryGeneration: input.recoveryGeneration,
    identityGeneration: input.identityGeneration,
    replacementDeviceId,
    replacementEncryptionPrivateKey: replacementEncryption.privateKey,
    replacementSigningPrivateKey: replacementSigning.privateKey,
  });
};

export const openRecoveryKit = async (
  encoded: Uint8Array,
  input: Readonly<{
    readonly serverProfileId: string;
    readonly userId: string;
    readonly activeDeviceSigningPublicKey: Uint8Array;
  }>,
): Promise<OpenedRecoveryKit> => {
  const kit = parseKit(encoded);
  const envelopeBytes = requireBytes(kit.get(2), "envelope");
  const recoveryPrivate = await importEncryptionPrivateKey(
    requireBytes(kit.get(3), "recovery private key"),
  );
  const recoverySigningPrivate = await importSigningPrivateKey(
    requireBytes(kit.get(4), "recovery signing key"),
  );
  const serverProfileId = bytesToUuid(
    requireBytes(kit.get(5), "server profile id", 16),
  );
  const userId = bytesToUuid(requireBytes(kit.get(6), "user id", 16));
  const envelopeId = bytesToUuid(requireBytes(kit.get(7), "envelope id", 16));
  const identityGeneration = requireNumber(kit.get(8), "identity generation");
  const recoveryGeneration = requireNumber(kit.get(9), "recovery generation");
  const replacementDeviceId = bytesToUuid(
    requireBytes(kit.get(10), "replacement device id", 16),
  );
  if (
    serverProfileId !== input.serverProfileId.toLowerCase() ||
    userId !== input.userId.toLowerCase()
  )
    throw new ProtocolVerificationError("Recovery Kit identity mismatch");
  const envelope = await verifySignedProtocolObject(
    envelopeBytes,
    input.activeDeviceSigningPublicKey,
  );
  if (
    envelope.get(1) !== 10 ||
    bytesToUuid(requireBytes(envelope.get(59), "envelope id", 16)) !==
      envelopeId
  )
    throw new ProtocolVerificationError(
      "Recovery Kit envelope binding mismatch",
    );
  if (
    bytesToUuid(requireBytes(envelope.get(8), "server profile id", 16)) !==
      serverProfileId ||
    bytesToUuid(requireBytes(envelope.get(9), "user id", 16)) !== userId ||
    requireNumber(envelope.get(28), "identity generation") !==
      identityGeneration ||
    requireNumber(envelope.get(29), "recovery generation") !==
      recoveryGeneration
  )
    throw new ProtocolVerificationError("Recovery envelope context mismatch");
  const associatedData = recoveryAssociatedData(
    serverProfileId,
    userId,
    envelopeId,
    replacementDeviceId,
    identityGeneration,
    recoveryGeneration,
  );
  let plaintext: Uint8Array;
  try {
    plaintext = await open(
      canonicalEncode(
        new Map<number, CborValue>([
          [0, envelope.get(0) as number],
          [44, envelope.get(44) as Uint8Array],
          [45, envelope.get(45) as Uint8Array],
          [46, envelope.get(46) as Uint8Array],
          [47, envelope.get(47) as Uint8Array],
          [48, envelope.get(48) as Uint8Array],
          [71, envelope.get(71) as number],
          [72, envelope.get(72) as number],
        ]),
      ),
      recoveryPrivate,
      associatedData,
    );
  } catch {
    throw new ProtocolVerificationError("Recovery Kit decryption failed");
  }
  const bundle = parseProtocolObject(plaintext);
  if (
    bundle.get(1) !== 11 ||
    bytesToUuid(requireBytes(bundle.get(9), "user id", 16)) !== userId
  )
    throw new ProtocolVerificationError("Recovery bundle identity mismatch");
  if (
    requireNumber(bundle.get(28), "identity generation") !==
      identityGeneration ||
    requireNumber(bundle.get(29), "recovery generation") !== recoveryGeneration
  )
    throw new ProtocolVerificationError("Recovery bundle generation mismatch");
  return Object.freeze({
    envelope,
    envelopeBytes: new Uint8Array(envelopeBytes),
    envelopeId,
    userId,
    identityGeneration,
    recoveryGeneration,
    replacementDeviceId,
    replacementEncryptionPrivateKey: await importEncryptionPrivateKey(
      requireBytes(bundle.get(80), "replacement encryption key"),
    ),
    replacementSigningPrivateKey: await importSigningPrivateKey(
      requireBytes(bundle.get(81), "replacement signing key"),
    ),
    recoveryEncryptionPrivateKey: recoveryPrivate,
    recoverySigningPrivateKey: recoverySigningPrivate,
  });
};

export const createRecoveredDeviceCertificate = async (
  input: Readonly<{
    readonly kit: OpenedRecoveryKit;
    readonly serverProfileId: string;
    readonly userId: string;
  }>,
): Promise<RecoveredDeviceCertificate> => {
  const x25519PublicKey = await exportEncryptionPublicKey(
    input.kit.replacementEncryptionPrivateKey,
  );
  const ed25519PublicKey = await exportSigningPublicKey(
    input.kit.replacementSigningPrivateKey,
  );
  const certificateId = crypto.randomUUID();
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.serverProfileId)],
    [9, uuidToBytes(input.userId)],
    [10, uuidToBytes(input.kit.replacementDeviceId)],
    [17, uuidToBytes(crypto.randomUUID())],
    [28, input.kit.identityGeneration],
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
  signedFields.set(
    4,
    await signProtocolObject(
      protocolObjectFromFields(2, signedFields),
      input.kit.replacementSigningPrivateKey,
    ),
  );
  const certificateBytes = encodeProtocolObject(
    protocolObjectFromFields(2, signedFields),
  );
  return Object.freeze({
    deviceId: input.kit.replacementDeviceId,
    identityGeneration: input.kit.identityGeneration,
    keyId: await sha384(x25519PublicKey),
    x25519PublicKey,
    ed25519PublicKey,
    certificateId,
    certificateBytes,
  });
};

export const createRecoveryChallengeProof = async (
  input: Readonly<{
    readonly serverProfileId: string;
    readonly userId: string;
    readonly replacementDeviceId: string;
    readonly correlationId?: string;
    readonly identityGeneration: number;
    readonly recoveryGeneration: number;
    readonly challenge: Uint8Array;
    readonly expiresAtMs: number;
    readonly signingPrivateKey: CryptoKey;
  }>,
): Promise<RecoveryChallengeProof> => {
  if (input.challenge.length !== 32)
    throw new TypeError("recovery challenge must be 32 bytes");
  if (
    !Number.isSafeInteger(input.identityGeneration) ||
    input.identityGeneration < 0 ||
    !Number.isSafeInteger(input.recoveryGeneration) ||
    input.recoveryGeneration < 1 ||
    !Number.isSafeInteger(input.expiresAtMs) ||
    input.expiresAtMs <= Date.now()
  )
    throw new TypeError("recovery challenge context is invalid");
  const challengeHash = await sha384(input.challenge);
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.serverProfileId)],
    [9, uuidToBytes(input.userId)],
    [10, uuidToBytes(input.replacementDeviceId)],
    [17, uuidToBytes(input.correlationId ?? crypto.randomUUID())],
    [28, input.identityGeneration],
    [29, input.recoveryGeneration],
    [32, Date.now()],
    [33, input.expiresAtMs],
    [58, challengeHash],
  ]);
  const unsigned = protocolObjectFromFields(17, fields);
  const signedFields = new Map<number, CborValue>([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  signedFields.set(
    4,
    await signProtocolObject(
      protocolObjectFromFields(17, signedFields),
      input.signingPrivateKey,
    ),
  );
  const canonicalBytes = encodeProtocolObject(
    protocolObjectFromFields(17, signedFields),
  );
  return Object.freeze({
    canonicalBytes,
    digest: await sha384(canonicalBytes),
    challengeHash,
  });
};

export const verifyRecoveryChallengeProof = async (
  proofBytes: Uint8Array,
  input: Readonly<{
    readonly challenge: Uint8Array;
    readonly serverProfileId: string;
    readonly userId: string;
    readonly replacementDeviceId: string;
    readonly signingPublicKey: Uint8Array;
  }>,
): Promise<ReadonlyMap<number, CborValue>> => {
  if (input.challenge.length !== 32)
    throw new TypeError("recovery challenge must be 32 bytes");
  const proof = await verifySignedProtocolObject(
    proofBytes,
    input.signingPublicKey,
  );
  if (
    proof.get(1) !== 17 ||
    bytesToUuid(requireBytes(proof.get(8), "server profile id", 16)) !==
      input.serverProfileId.toLowerCase() ||
    bytesToUuid(requireBytes(proof.get(9), "user id", 16)) !==
      input.userId.toLowerCase() ||
    bytesToUuid(requireBytes(proof.get(10), "device id", 16)) !==
      input.replacementDeviceId.toLowerCase() ||
    !equal(
      requireBytes(proof.get(58), "challenge hash", 48),
      await sha384(input.challenge),
    )
  )
    throw new ProtocolVerificationError(
      "recovery challenge proof binding mismatch",
    );
  return proof;
};
