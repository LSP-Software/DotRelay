import { expect, test } from "bun:test";
import {
  canonicalEncode,
  deviceRecoveryMessage,
  encodeProtocolObject,
  parseProtocolObject,
  sha384,
} from "@dotrelay/contracts";
import {
  createAccountKeyWrapper,
  generateAccountMasterKey,
  generateRecoveryCode,
} from "../account";
import { createDeviceBootstrap } from "./bootstrap";
import { prepareDeviceRecovery } from "./recovery";

const fixture = async () => {
  const pin = {
    origin: "https://relay.example",
    serverProfileId: crypto.randomUUID(),
  };
  const userId = crypto.randomUUID();
  const device = await createDeviceBootstrap({ pin, userId });
  const code = generateRecoveryCode();
  const accountMasterKey = generateAccountMasterKey();
  const wrapper = await createAccountKeyWrapper({
    serverProfileId: pin.serverProfileId,
    userId: device.bundle.userId,
    deviceId: device.bundle.deviceId,
    userIdentityGeneration: 1,
    createdAtMs: Date.now(),
    accountMasterKey,
    signingPrivateKey: device.keyMaterial.signingPrivateKey,
    kind: { type: "recoveryCode", recoveryCode: code },
  });
  const input = {
    pin,
    userId,
    recoveryCode: code,
    wrapperBytes: encodeProtocolObject(wrapper.object),
    creatorPublicKey: device.ed25519PublicKey,
  };
  return { input, wrapper, accountMasterKey };
};

test("a clean installation recovers the existing AMK and proves ownership of its exact Device certificate", async () => {
  const { input, wrapper, accountMasterKey } = await fixture();
  const result = await prepareDeviceRecovery(input);
  expect(result.accountMasterKey).toEqual(accountMasterKey);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(wrapper.object.get(97) as Uint8Array),
    "Ed25519",
    false,
    ["verify"],
  );
  const signature = Uint8Array.from(
    atob(result.request.recovery.signature),
    (ch) => ch.charCodeAt(0),
  );
  const message = deviceRecoveryMessage(
    input.pin.serverProfileId,
    input.userId,
    result.request.operationId,
    result.bootstrap.certificate.digest,
  );
  expect(
    await crypto.subtle.verify("Ed25519", publicKey, signature, message),
  ).toBe(true);
  for (const mutation of [
    deviceRecoveryMessage(
      input.pin.serverProfileId,
      crypto.randomUUID(),
      result.request.operationId,
      result.bootstrap.certificate.digest,
    ),
    deviceRecoveryMessage(
      crypto.randomUUID(),
      input.userId,
      result.request.operationId,
      result.bootstrap.certificate.digest,
    ),
    deviceRecoveryMessage(
      input.pin.serverProfileId,
      input.userId,
      crypto.randomUUID(),
      result.bootstrap.certificate.digest,
    ),
    deviceRecoveryMessage(
      input.pin.serverProfileId,
      input.userId,
      result.request.operationId,
      await sha384(new Uint8Array([1])),
    ),
  ])
    expect(
      await crypto.subtle.verify("Ed25519", publicKey, signature, mutation),
    ).toBe(false);
  expect(JSON.stringify(result.request)).not.toContain(
    Buffer.from(input.recoveryCode).toString("hex"),
  );
});

test("wrong codes, another User, and a substituted wrapper verifier cannot authorize recovery", async () => {
  const { input, wrapper } = await fixture();
  await expect(
    prepareDeviceRecovery({ ...input, recoveryCode: generateRecoveryCode() }),
  ).rejects.toThrow();
  await expect(
    prepareDeviceRecovery({ ...input, userId: crypto.randomUUID() }),
  ).rejects.toThrow();
  const object = new Map(wrapper.object);
  object.set(97, crypto.getRandomValues(new Uint8Array(32)));
  await expect(
    prepareDeviceRecovery({ ...input, wrapperBytes: canonicalEncode(object) }),
  ).rejects.toThrow();
  expect(parseProtocolObject(input.wrapperBytes).get(97)).toBeInstanceOf(
    Uint8Array,
  );
});
