import {
  type ProtocolObject,
  parseProtocolObject,
  sha384,
  verifyProtocolObject,
} from "@dotrelay/contracts";

import {
  ACCOUNT_KEY_ENVELOPE_KIND,
  ACCOUNT_KEY_TRANSFER_KIND,
  ACCOUNT_KEY_WRAPPER_KIND,
  KEY_ENVELOPE_TYPE,
  WRAPPER_TYPE,
} from "./constants";

// A trusted Ed25519 signing public key (raw 32 bytes) that is allowed to have
// signed an account-key object. Callers assemble this set from their trust
// boundary: the local Device's signing key plus the peer Devices' keys (and,
// for API-issued objects, the creator Device's key). Verification succeeds if
// at least one trusted key validates the field-4 signature over the canonical
// unsigned body, mirroring sync revision authorization.
export type AccountKeyTrustedKeys = Readonly<{
  readonly keys: readonly Uint8Array[];
}>;

// Expected values for the identity fields of an account-key object. Every field
// is optional: when a value is provided it is checked against the object (a
// mismatch is a verification failure); when omitted, only the field's presence
// and well-formedness are checked. Identity fields are covered by the signature
// and, for sealed objects, by the AAD, so callers that cannot know a value in
// advance can still get signature + digest + AAD protection.
export type AccountKeyVerificationContext = Readonly<{
  readonly serverProfileId?: Uint8Array;
  readonly userId?: Uint8Array;
  readonly deviceId?: Uint8Array;
  readonly userIdentityGeneration?: number;
}>;

export type AccountKeyEnvelopeVerificationContext =
  AccountKeyVerificationContext & {
    readonly envelopeType: number;
    readonly projectId?: Uint8Array;
    readonly projectEpoch?: number;
    readonly ownerUserId?: Uint8Array;
    readonly valueGeneration?: number;
  };

export type AccountKeyTransferVerificationContext =
  AccountKeyVerificationContext & {
    // The device that will open the transfer; field 25 must equal this when
    // both ownDeviceId and nowMs are provided (a transfer targeted at another
    // device is not opened by this caller).
    readonly ownDeviceId?: Uint8Array;
    // Current time in Unix milliseconds; field 33 must be after this.
    readonly nowMs?: number;
  };

export class AccountKeyVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountKeyVerificationError";
  }
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

// Check that a 16-byte identity field is present and, when an expected value is
// given, equal to it.
const checkIdentityField = (
  object: ProtocolObject,
  field: number,
  expected: Uint8Array | undefined,
): void => {
  const value = object.get(field);
  if (!(value instanceof Uint8Array) || value.length !== 16)
    throw new AccountKeyVerificationError(
      `field ${field} must be a 16-byte id`,
    );
  if (expected !== undefined && !sameBytes(value, expected))
    throw new AccountKeyVerificationError(`field ${field} binding mismatch`);
};

const checkGenerationField = (
  object: ProtocolObject,
  field: number,
  expected: number | undefined,
): void => {
  const value = object.get(field);
  if (typeof value !== "number" && typeof value !== "bigint") return;
  if (value < 0)
    throw new AccountKeyVerificationError(
      `field ${field} must be non-negative`,
    );
  if (expected !== undefined && Number(value) !== expected)
    throw new AccountKeyVerificationError(`field ${field} is stale`);
};

// Verify the field-4 Ed25519 signature against any of the trusted keys. A
// trusted key is the Ed25519 signing public key in either its 32-byte raw form
// (boundary / API-reported keys) or its 44-byte SPKI form (a locally exported
// key); the import below mirrors verifySignedProtocolObject so both are
// accepted. Throws if no trusted key validates the signature.
const verifySignature = async (
  object: ProtocolObject,
  trustedKeys: AccountKeyTrustedKeys,
): Promise<void> => {
  const signature = object.get(4);
  if (!(signature instanceof Uint8Array) || signature.length !== 64)
    throw new AccountKeyVerificationError("signature field is missing");
  for (const keyBytes of trustedKeys.keys) {
    try {
      const publicKey = await crypto.subtle.importKey(
        keyBytes.length === 32 ? "raw" : "spki",
        new Uint8Array(keyBytes).buffer,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      if (await verifyProtocolObject(object, signature, publicKey)) return;
    } catch {
      // A malformed trusted key must not mask a valid one.
    }
  }
  throw new AccountKeyVerificationError(
    "account key object signature is not authorized by any trusted key",
  );
};

// Recompute SHA-384(ciphertext) and compare it to the stored digest so a
// ciphertext tamper is caught before the GCM tag check.
const verifyCiphertextHash = async (object: ProtocolObject): Promise<void> => {
  const ciphertext = object.get(47);
  const expected = object.get(48);
  if (!(ciphertext instanceof Uint8Array) || !(expected instanceof Uint8Array))
    throw new AccountKeyVerificationError("ciphertext fields are missing");
  const actual = await sha384(ciphertext);
  if (!sameBytes(actual, expected))
    throw new AccountKeyVerificationError("ciphertext hash mismatch");
};

const verifyIdentityFields = (
  object: ProtocolObject,
  context: AccountKeyVerificationContext,
): void => {
  checkIdentityField(object, 8, context.serverProfileId);
  checkIdentityField(object, 9, context.userId);
  checkIdentityField(object, 10, context.deviceId);
  checkGenerationField(object, 28, context.userIdentityGeneration);
};

// Verify an Account Key Wrapper (kind 20): Ed25519 signature over the canonical
// unsigned body by a trusted key, ciphertext-digest integrity, and identity
// bindings. MUST run before any KDF or decryption in unwrapAccountKeyWrapper.
export const verifyAccountKeyWrapper = async (
  objectOrBytes: ProtocolObject | Uint8Array,
  trustedKeys: AccountKeyTrustedKeys,
  context: AccountKeyVerificationContext = {},
): Promise<void> => {
  const object =
    objectOrBytes instanceof Uint8Array
      ? parseProtocolObject(objectOrBytes)
      : objectOrBytes;
  if (object.get(1) !== ACCOUNT_KEY_WRAPPER_KIND)
    throw new AccountKeyVerificationError("expected an Account Key Wrapper");
  const wrapperType = object.get(86);
  if (
    wrapperType !== WRAPPER_TYPE.passkeyPrf &&
    wrapperType !== WRAPPER_TYPE.password &&
    wrapperType !== WRAPPER_TYPE.recoveryCode
  )
    throw new AccountKeyVerificationError("wrapper has unknown type");
  await verifySignature(object, trustedKeys);
  await verifyCiphertextHash(object);
  verifyIdentityFields(object, context);
};

const verifyEnvelopeBindings = (
  object: ProtocolObject,
  context: AccountKeyEnvelopeVerificationContext,
): void => {
  const envelopeType = object.get(96);
  if (envelopeType !== context.envelopeType)
    throw new AccountKeyVerificationError("envelope type binding mismatch");
  if (envelopeType === KEY_ENVELOPE_TYPE.projectEpochKey) {
    const projectId = object.get(13);
    if (!(projectId instanceof Uint8Array) || projectId.length !== 16)
      throw new AccountKeyVerificationError("project id field is missing");
    if (
      context.projectId !== undefined &&
      !sameBytes(projectId, context.projectId)
    )
      throw new AccountKeyVerificationError("project id binding mismatch");
    checkGenerationField(object, 30, context.projectEpoch);
  } else if (envelopeType === KEY_ENVELOPE_TYPE.userValueKey) {
    checkIdentityField(object, 26, context.ownerUserId);
    checkGenerationField(object, 31, context.valueGeneration);
  } else {
    throw new AccountKeyVerificationError("envelope has unknown type");
  }
};

// Verify an Account Key Envelope (kind 21). MUST run before decryption in
// openAccountKeyEnvelope.
export const verifyAccountKeyEnvelope = async (
  objectOrBytes: ProtocolObject | Uint8Array,
  trustedKeys: AccountKeyTrustedKeys,
  context: AccountKeyEnvelopeVerificationContext,
): Promise<void> => {
  const object =
    objectOrBytes instanceof Uint8Array
      ? parseProtocolObject(objectOrBytes)
      : objectOrBytes;
  if (object.get(1) !== ACCOUNT_KEY_ENVELOPE_KIND)
    throw new AccountKeyVerificationError("expected an Account Key Envelope");
  await verifySignature(object, trustedKeys);
  await verifyCiphertextHash(object);
  verifyIdentityFields(object, context);
  verifyEnvelopeBindings(object, context);
};

const verifyTransferBindings = (
  object: ProtocolObject,
  context: AccountKeyTransferVerificationContext,
): void => {
  const recipient = object.get(25);
  if (context.ownDeviceId !== undefined) {
    if (
      !(recipient instanceof Uint8Array) ||
      !sameBytes(recipient, context.ownDeviceId)
    )
      throw new AccountKeyVerificationError(
        "transfer recipient is not this device",
      );
    const expiresAt = object.get(33);
    if (context.nowMs !== undefined) {
      const isNumeric =
        typeof expiresAt === "number" || typeof expiresAt === "bigint";
      if (!isNumeric || Number(expiresAt) <= context.nowMs)
        throw new AccountKeyVerificationError("transfer has expired");
    }
  }
};

// Verify an Account Key Transfer (kind 22): signature, ciphertext digest,
// identity bindings, and (when the caller provides ownDeviceId) that the
// transfer is addressed to this device and unexpired. MUST run before opening
// in openAccountKeyTransfer.
export const verifyAccountKeyTransfer = async (
  objectOrBytes: ProtocolObject | Uint8Array,
  trustedKeys: AccountKeyTrustedKeys,
  context: AccountKeyTransferVerificationContext = {},
): Promise<void> => {
  const object =
    objectOrBytes instanceof Uint8Array
      ? parseProtocolObject(objectOrBytes)
      : objectOrBytes;
  if (object.get(1) !== ACCOUNT_KEY_TRANSFER_KIND)
    throw new AccountKeyVerificationError("expected an Account Key Transfer");
  await verifySignature(object, trustedKeys);
  await verifyCiphertextHash(object);
  verifyIdentityFields(object, context);
  verifyTransferBindings(object, context);
};
