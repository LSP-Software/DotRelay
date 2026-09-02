import {
  type CborValue,
  canonicalEncode,
  decodeCiphertextEnvelope,
  encodeProtocolObject,
  protocolObjectFromFields,
  seal,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";

export type ProjectEpochGrantBootstrap = Readonly<{
  readonly objectId: string;
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
  readonly plaintextKey: Uint8Array;
}>;

const zeroize = (value: Uint8Array): void => {
  value.fill(0);
};

export const createProjectEpochGrantBootstrap = async (
  input: Readonly<{
    readonly serverProfileId: string;
    readonly teamId: string;
    readonly projectId: string;
    readonly projectEpoch: number;
    readonly senderDeviceId: string;
    readonly recipientDeviceId: string;
    readonly recipientX25519PublicKey: Uint8Array;
    readonly recipientEncryptionPublicKey: CryptoKey;
    readonly signingPrivateKey: CryptoKey;
  }>,
): Promise<ProjectEpochGrantBootstrap> => {
  if (
    !Number.isSafeInteger(input.projectEpoch) ||
    input.projectEpoch < 1 ||
    input.recipientX25519PublicKey.length !== 32
  )
    throw new TypeError("project grant context is invalid");
  const plaintextKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const envelopeBytes = await seal(
      plaintextKey,
      input.recipientEncryptionPublicKey,
    );
    const envelope = decodeCiphertextEnvelope(envelopeBytes);
    const salt = envelope.get(44);
    const ephemeralPublicKey = envelope.get(45);
    const iv = envelope.get(46);
    const ciphertext = envelope.get(47);
    const ciphertextHash = envelope.get(48);
    const plaintextLength = envelope.get(71);
    const ciphertextLength = envelope.get(72);
    if (
      !(salt instanceof Uint8Array) ||
      !(ephemeralPublicKey instanceof Uint8Array) ||
      !(iv instanceof Uint8Array) ||
      !(ciphertext instanceof Uint8Array) ||
      !(ciphertextHash instanceof Uint8Array) ||
      typeof plaintextLength !== "number" ||
      typeof ciphertextLength !== "number"
    )
      throw new Error("project grant envelope is malformed");
    const objectId = crypto.randomUUID();
    const grantFields = new Map<number, CborValue>([
      [8, uuidToBytes(input.serverProfileId)],
      [11, uuidToBytes(input.teamId)],
      [13, uuidToBytes(input.projectId)],
      [17, uuidToBytes(crypto.randomUUID())],
      [24, uuidToBytes(input.senderDeviceId)],
      [25, uuidToBytes(input.recipientDeviceId)],
      [30, input.projectEpoch],
      [37, 1],
      [39, new Uint8Array(input.recipientX25519PublicKey)],
      [44, salt],
      [45, ephemeralPublicKey],
      [46, iv],
      [47, ciphertext],
      [48, ciphertextHash],
      [70, 1],
      [71, plaintextLength],
      [72, ciphertextLength],
    ]);
    const unsigned = protocolObjectFromFields(7, grantFields);
    const fields = new Map<number, CborValue>([
      ...grantFields,
      [3, canonicalEncode(unsigned)],
      [4, new Uint8Array(64)],
    ]);
    const signature = await signProtocolObject(
      protocolObjectFromFields(7, fields),
      input.signingPrivateKey,
    );
    fields.set(4, signature);
    const canonicalBytes = encodeProtocolObject(
      protocolObjectFromFields(7, fields),
    );
    return Object.freeze({
      objectId,
      canonicalBytes,
      digest: await sha384(canonicalBytes),
      plaintextKey: new Uint8Array(plaintextKey),
    });
  } finally {
    zeroize(plaintextKey);
  }
};
