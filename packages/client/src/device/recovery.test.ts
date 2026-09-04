import { describe, expect, test } from "bun:test";
import {
  exportSigningPublicKey,
  generateSigningKeyPair,
} from "@dotrelay/contracts";
import {
  createRecoveryChallengeProof,
  createRecoveryKit,
  openRecoveryKit,
  verifyRecoveryChallengeProof,
} from "../index";

const context = Object.freeze({
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
});

describe("Recovery Kit", () => {
  test("round-trips an encrypted replacement Device bundle", async () => {
    const activeDevice = await generateSigningKeyPair();
    const kit = await createRecoveryKit({
      ...context,
      identityGeneration: 7,
      recoveryGeneration: 3,
      replacementDeviceId: "33333333-3333-4333-8333-333333333333",
      activeDeviceSigningPrivateKey: activeDevice.privateKey,
    });
    const opened = await openRecoveryKit(kit.bytes, {
      ...context,
      activeDeviceSigningPublicKey: await exportSigningPublicKey(
        activeDevice.publicKey,
      ),
    });
    expect(opened.envelopeId).toBe(kit.envelopeId);
    expect(opened.recoveryGeneration).toBe(3);
    expect(opened.identityGeneration).toBe(7);
    expect(opened.replacementDeviceId).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(opened.replacementSigningPrivateKey.type).toBe("private");
  });

  test("binds the kit to the profile and user", async () => {
    const activeDevice = await generateSigningKeyPair();
    const kit = await createRecoveryKit({
      ...context,
      identityGeneration: 1,
      recoveryGeneration: 1,
      activeDeviceSigningPrivateKey: activeDevice.privateKey,
    });
    await expect(
      openRecoveryKit(kit.bytes, {
        ...context,
        userId: "44444444-4444-4444-8444-444444444444",
        activeDeviceSigningPublicKey: await exportSigningPublicKey(
          activeDevice.publicKey,
        ),
      }),
    ).rejects.toThrow("identity mismatch");
  });

  test("rejects a modified kit", async () => {
    const activeDevice = await generateSigningKeyPair();
    const kit = await createRecoveryKit({
      ...context,
      identityGeneration: 1,
      recoveryGeneration: 2,
      activeDeviceSigningPrivateKey: activeDevice.privateKey,
    });
    const modified = new Uint8Array(kit.bytes);
    modified[modified.length - 1] = (modified[modified.length - 1] ?? 0) ^ 1;
    await expect(
      openRecoveryKit(modified, {
        ...context,
        activeDeviceSigningPublicKey: await exportSigningPublicKey(
          activeDevice.publicKey,
        ),
      }),
    ).rejects.toThrow("Recovery Kit decryption failed");
  });

  test("builds and verifies a one-time challenge proof", async () => {
    const signing = await generateSigningKeyPair();
    const challenge = new Uint8Array(32).fill(8);
    const proof = await createRecoveryChallengeProof({
      ...context,
      replacementDeviceId: "33333333-3333-4333-8333-333333333333",
      identityGeneration: 2,
      recoveryGeneration: 4,
      challenge,
      expiresAtMs: Date.now() + 60_000,
      signingPrivateKey: signing.privateKey,
    });
    const parsed = await verifyRecoveryChallengeProof(proof.canonicalBytes, {
      ...context,
      replacementDeviceId: "33333333-3333-4333-8333-333333333333",
      challenge,
      signingPublicKey: await exportSigningPublicKey(signing.publicKey),
    });
    expect(parsed.get(1)).toBe(17);
    expect(proof.challengeHash).toHaveLength(48);
  });
});
