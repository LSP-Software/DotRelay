import {
  type CborValue,
  canonicalEncode,
  decodeCiphertextEnvelope,
  encodeProtocolObject,
  open,
  parseProtocolObject,
  protocolObjectFromFields,
  seal,
  sha384,
  signProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import { isSignedByTrustedKey } from "../trust/verify";

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
    readonly plaintextKey?: Uint8Array;
  }>,
): Promise<ProjectEpochGrantBootstrap> => {
  if (
    !Number.isSafeInteger(input.projectEpoch) ||
    input.projectEpoch < 1 ||
    input.recipientX25519PublicKey.length !== 32
  )
    throw new TypeError("project grant context is invalid");
  if (input.plaintextKey && input.plaintextKey.length !== 32)
    throw new TypeError("project grant key must be 32 bytes");
  const plaintextKey = input.plaintextKey
    ? new Uint8Array(input.plaintextKey)
    : crypto.getRandomValues(new Uint8Array(32));
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

// The context a caller expects a Project grant to carry. Recipient, Project
// and epoch are always known; the Server Profile and Team are checked when the
// caller knows them.
export type ProjectEpochGrantExpectation = Readonly<{
  readonly recipientDeviceId: string;
  readonly projectId: string;
  readonly projectEpoch: number;
  readonly serverProfileId?: string;
  readonly teamId?: string;
}>;

export type ProjectEpochGrantVerification = Readonly<{
  readonly expected: ProjectEpochGrantExpectation;
  // Ed25519 signing public keys (raw 32 bytes or SPKI) of the Devices allowed
  // to have issued the grant.
  readonly trustedSigningKeys: readonly Uint8Array[];
}>;

export class ProjectEpochGrantVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectEpochGrantVerificationError";
  }
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

// Open a kind-7 Project grant. The server is untrusted, so the grant's
// field-4 signature must verify against a key in the caller's trusted signing
// set and its recipient, Project, epoch (and Server Profile and Team when
// known) must match what the caller expects. Every check runs before the
// envelope is decrypted; the envelope itself is unchanged so stored grants
// keep opening.
export const openProjectEpochGrant = async (
  canonicalBytes: Uint8Array,
  recipientPrivateKey: CryptoKey,
  verification: ProjectEpochGrantVerification,
): Promise<Uint8Array> => {
  const object = parseProtocolObject(canonicalBytes);
  if (object.get(1) !== 7) throw new TypeError("expected a grant object");
  const requiredField = (key: number): CborValue => {
    const value = object.get(key);
    if (value === undefined)
      throw new TypeError(`grant object is missing field ${key}`);
    return value;
  };
  if (!(await isSignedByTrustedKey(object, verification.trustedSigningKeys)))
    throw new ProjectEpochGrantVerificationError(
      "project grant signature is not authorized by any trusted key",
    );
  const { expected } = verification;
  const checkId = (field: number, value: string | undefined): void => {
    if (value === undefined) return;
    const actual = object.get(field);
    if (
      !(actual instanceof Uint8Array) ||
      !sameBytes(actual, uuidToBytes(value))
    )
      throw new ProjectEpochGrantVerificationError(
        `project grant field ${field} binding mismatch`,
      );
  };
  checkId(25, expected.recipientDeviceId);
  checkId(13, expected.projectId);
  checkId(8, expected.serverProfileId);
  checkId(11, expected.teamId);
  const epoch = object.get(30);
  if (
    (typeof epoch !== "number" && typeof epoch !== "bigint") ||
    !Number.isSafeInteger(expected.projectEpoch) ||
    BigInt(epoch) !== BigInt(expected.projectEpoch)
  )
    throw new ProjectEpochGrantVerificationError(
      "project grant epoch binding mismatch",
    );
  const envelope = canonicalEncode(
    new Map<number, CborValue>([
      [0, requiredField(0)],
      [44, requiredField(44)],
      [45, requiredField(45)],
      [46, requiredField(46)],
      [47, requiredField(47)],
      [48, requiredField(48)],
      [71, requiredField(71)],
      [72, requiredField(72)],
    ]),
  );
  return open(envelope, recipientPrivateKey);
};
