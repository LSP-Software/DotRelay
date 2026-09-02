import { describe, expect, test } from "bun:test";
import {
  canonicalEncode,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  open,
  parseProtocolObject,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import {
  createProjectEpochGrantBootstrap,
  exportSigningPublicKey,
} from "../index";

describe("project epoch grant bootstrap", () => {
  test("creates a signed grant with an encrypted project key", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const grant = await createProjectEpochGrantBootstrap({
      serverProfileId: "11111111-1111-4111-8111-111111111111",
      teamId: "22222222-2222-4222-8222-222222222222",
      projectId: "33333333-3333-4333-8333-333333333333",
      projectEpoch: 1,
      senderDeviceId: "44444444-4444-4444-8444-444444444444",
      recipientDeviceId: "44444444-4444-4444-8444-444444444444",
      recipientX25519PublicKey: new Uint8Array(32),
      recipientEncryptionPublicKey: encryption.publicKey,
      signingPrivateKey: signing.privateKey,
    });
    const object = parseProtocolObject(grant.canonicalBytes);
    expect(object.get(1)).toBe(7);
    expect(object.get(70)).toBe(1);
    expect(grant.digest).toHaveLength(48);
    await verifyProtocolObject(
      object,
      object.get(4) as Uint8Array,
      await importPublicSigningKey(
        await exportSigningPublicKey(signing.publicKey),
      ),
    );
    const envelope = canonicalEncode(
      new Map([
        [0, object.get(0)],
        [44, object.get(44)],
        [45, object.get(45)],
        [46, object.get(46)],
        [47, object.get(47)],
        [48, object.get(48)],
        [71, object.get(71)],
        [72, object.get(72)],
      ]),
    );
    expect(await open(envelope, encryption.privateKey)).toEqual(
      grant.plaintextKey,
    );
    expect(grant.plaintextKey).toHaveLength(32);
  });
});

const importPublicSigningKey = async (bytes: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "spki",
    new Uint8Array(bytes).buffer,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
