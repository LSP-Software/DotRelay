// Domain-separated message a recipient Device signs to acknowledge an Account
// Key Transfer. The signature is not a protocol object: field numbers of
// wrapper kind 20, envelope kind 21, and transfer kind 22 stay unchanged.
const ACKNOWLEDGEMENT_PREFIX = "dotrelay-account-key-transfer-ack-v1\0";

export const accountKeyTransferAcknowledgementMessage = (
  transferId: Uint8Array,
): Uint8Array<ArrayBuffer> => {
  if (transferId.length !== 16)
    throw new Error("account key transfer id must be 16 bytes");
  const prefix = new TextEncoder().encode(ACKNOWLEDGEMENT_PREFIX);
  const buffer = new ArrayBuffer(prefix.length + transferId.length);
  const message = new Uint8Array(buffer);
  message.set(prefix, 0);
  message.set(transferId, prefix.length);
  return message;
};

// Binds a recovery authorization to this exact Device certificate, User,
// profile and idempotency key. No Recovery Code or AMK crosses the API.
export const deviceRecoveryMessage = (
  profileId: string,
  userId: string,
  operationId: string,
  certificateDigest: Uint8Array,
): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(
    JSON.stringify({
      purpose: "dotrelay-device-recovery-v1",
      profileId,
      userId,
      operationId,
      certificateDigest: Array.from(certificateDigest, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    }),
  );
