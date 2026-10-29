import {
  deviceRecoveryMessage,
  uuidToBytes,
  parseProtocolObject,
} from "@dotrelay/contracts";
import { parseAccountKeyWrapper, unwrapAccountKeyWrapper } from "../account";
import {
  recoveryAuthorizationKey,
  recoveryAuthorizationPublicKey,
} from "../account/recovery-authorization";
import { createDeviceBootstrap } from "./bootstrap";

// creatorPublicKey must come from the authenticated service's own User/Device
// association, never from untrusted handoff data or an arbitrary protocol object.
export const prepareDeviceRecovery = async (
  input: Readonly<{
    pin: Readonly<{ origin: string; serverProfileId: string }>;
    userId: string;
    recoveryCode: Uint8Array;
    wrapperBytes: Uint8Array;
    creatorPublicKey: Uint8Array;
  }>,
) => {
  const wrapper = parseAccountKeyWrapper(input.wrapperBytes);
  const object = parseProtocolObject(input.wrapperBytes);
  if (!(object.get(97) instanceof Uint8Array))
    throw new Error(
      "This Recovery Code predates Device recovery. Rotate it from an existing Device before losing access to that Device.",
    );
  const accountMasterKey = await unwrapAccountKeyWrapper(
    wrapper,
    { recoveryCode: input.recoveryCode },
    {
      trustedKeys: { keys: [input.creatorPublicKey] },
      context: {
        serverProfileId: uuidToBytes(input.pin.serverProfileId),
        userId: uuidToBytes(input.userId),
      },
    },
  );
  const authorizationKey = await recoveryAuthorizationKey(
    input.recoveryCode,
    wrapper.salt,
  );
  const expected = object.get(97) as Uint8Array;
  const actual = await recoveryAuthorizationPublicKey(authorizationKey);
  if (!actual.every((byte, i) => byte === expected[i]))
    throw new Error("Recovery Code authorization mismatch");
  const generation = Number(object.get(28));
  const bootstrap = await createDeviceBootstrap({
    pin: input.pin,
    userId: input.userId,
    userIdentityGeneration: generation,
  });
  const operationId = crypto.randomUUID();
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      authorizationKey,
      deviceRecoveryMessage(
        input.pin.serverProfileId,
        input.userId,
        operationId,
        bootstrap.certificate.digest,
      ),
    ),
  );
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const base64 = (bytes: Uint8Array) =>
    btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
  return {
    bootstrap,
    accountMasterKey,
    request: {
      operationId,
      deviceId: bootstrap.deviceId,
      certificateId: bootstrap.certificate.id,
      identityGeneration: bootstrap.identityGeneration,
      keyId: hex(bootstrap.keyId),
      x25519PublicKey: hex(bootstrap.x25519PublicKey),
      ed25519PublicKey: hex(bootstrap.ed25519PublicKey),
      certificate: base64(bootstrap.certificate.canonicalBytes),
      recovery: {
        wrapperId: hex(wrapper.wrapperId),
        signature: base64(signature),
      },
    },
  };
};
