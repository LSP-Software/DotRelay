import {
  importSigningPublicKey,
  type ProtocolObject,
  parseProtocolObject,
  sha384,
  validateProtocolObject,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import { revisionParentLink, trustedHeadFromRevision } from "./head";

export class ProtocolVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolVerificationError";
  }
}

const requireField = (
  object: ProtocolObject,
  field: number,
  length?: number,
): Uint8Array => {
  const value = object.get(field);
  if (!(value instanceof Uint8Array))
    throw new ProtocolVerificationError(`field ${field} must be bytes`);
  if (length !== undefined && value.length !== length)
    throw new ProtocolVerificationError(`field ${field} has invalid length`);
  return value;
};

export const verifySignedProtocolObject = async (
  bytes: Uint8Array,
  publicKeyBytes: Uint8Array,
): Promise<ProtocolObject> => {
  const object = parseProtocolObject(bytes);
  const signature = requireField(object, 4, 64);
  const publicKey = await importSigningPublicKey(publicKeyBytes);
  const verified = await verifyProtocolObject(object, signature, publicKey);
  if (!verified)
    throw new ProtocolVerificationError("signature verification failed");
  return object;
};

export const verifyRevisionChainLink = (
  revision: ProtocolObject,
  parent: ProtocolObject,
): void => {
  validateProtocolObject(revision);
  validateProtocolObject(parent);
  if (revision.get(1) !== 16 || parent.get(1) !== 16)
    throw new ProtocolVerificationError("expected revision objects");
  const link = revisionParentLink(revision);
  if (!link)
    throw new ProtocolVerificationError("revision parent link is missing");
  if (
    !sameBytes(link.parentId, requireField(parent, 16, 16)) ||
    !sameBytes(link.parentHash, requireField(parent, 52, 48))
  )
    throw new ProtocolVerificationError("revision parent link mismatch");
};

export const verifyRevisionIntegrity = async (
  revisionBytes: Uint8Array,
  signingPublicKey: Uint8Array,
  parentBytes?: Uint8Array,
): Promise<ReturnType<typeof trustedHeadFromRevision>> => {
  const revision = await verifySignedProtocolObject(
    revisionBytes,
    signingPublicKey,
  );
  if (parentBytes) {
    const parent = parseProtocolObject(parentBytes);
    verifyRevisionChainLink(revision, parent);
  }
  const manifestHash = requireField(revision, 52, 48);
  const manifestDescriptor = revision.get(51);
  if (manifestDescriptor instanceof Uint8Array) {
    const digest = await sha384(manifestDescriptor);
    if (!sameBytes(digest, manifestHash))
      throw new ProtocolVerificationError("manifest hash mismatch");
  }
  const epoch = revision.get(30);
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)
    throw new ProtocolVerificationError("project epoch is invalid");
  return trustedHeadFromRevision(revision);
};

export const verifyGrantDigest = (
  grant: ProtocolObject,
  expectedRecipientDeviceId: Uint8Array,
): void => {
  if (![7, 8, 9].includes(grant.get(1) as number))
    throw new ProtocolVerificationError("expected grant object");
  const recipient = requireField(grant, 25, 16);
  if (!sameBytes(recipient, expectedRecipientDeviceId))
    throw new ProtocolVerificationError("grant recipient mismatch");
  const ciphertextHash = grant.get(48);
  const ciphertext = grant.get(47);
  if (
    ciphertext instanceof Uint8Array &&
    ciphertextHash instanceof Uint8Array &&
    ciphertextHash.length !== 48
  )
    throw new ProtocolVerificationError("grant ciphertext hash is invalid");
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};
