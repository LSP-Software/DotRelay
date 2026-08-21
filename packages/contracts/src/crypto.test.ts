import { describe, expect, test } from "bun:test";
import { canonicalEncode } from "./cbor";
import {
  CRYPTO_SUITE,
  decodeCiphertextEnvelope,
  encodeCiphertextEnvelope,
  exportEncryptionPrivateKey,
  exportEncryptionPublicKey,
  exportSigningPrivateKey,
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  InvalidCiphertextError,
  importEncryptionPrivateKey,
  importEncryptionPublicKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  open,
  seal,
  sha384,
  sign,
  signProtocolObject,
  verify,
  verifyProtocolObject,
} from "./crypto";
import { protocolObjectFromFields } from "./protocol";

const encoder = new TextEncoder();

describe("v3 native WebCrypto core", () => {
  test("generates, exports, imports, and round-trips X25519 keys", async () => {
    const original = await generateEncryptionKeyPair();
    const publicKeyBytes = await exportEncryptionPublicKey(original.publicKey);
    const privateKeyBytes = await exportEncryptionPrivateKey(
      original.privateKey,
    );
    const publicKey = await importEncryptionPublicKey(publicKeyBytes);
    const privateKey = await importEncryptionPrivateKey(privateKeyBytes);
    const envelope = await seal(
      encoder.encode("portable key material"),
      publicKey,
    );

    expect(publicKeyBytes.length).toBeGreaterThan(32);
    expect(privateKeyBytes.length).toBeGreaterThan(32);
    expect(await open(envelope, privateKey)).toEqual(
      encoder.encode("portable key material"),
    );
  });

  test("encrypts with fresh ephemeral, salt, IV, and ciphertext material", async () => {
    const recipient = await generateEncryptionKeyPair();
    const message = encoder.encode("same plaintext");
    const first = await seal(message, recipient.publicKey);
    const second = await seal(message, recipient.publicKey);
    const firstEnvelope = decodeCiphertextEnvelope(first);
    const secondEnvelope = decodeCiphertextEnvelope(second);

    expect(first).not.toEqual(second);
    expect(firstEnvelope.get(44)).not.toEqual(secondEnvelope.get(44));
    expect(firstEnvelope.get(45)).not.toEqual(secondEnvelope.get(45));
    expect(firstEnvelope.get(46)).not.toEqual(secondEnvelope.get(46));
  });

  test("rejects tampering, wrong recipients, wrong context, and malformed envelopes generically", async () => {
    const recipient = await generateEncryptionKeyPair();
    const wrongRecipient = await generateEncryptionKeyPair();
    const context = encoder.encode("project:demo/environment:development");
    const envelope = await seal(
      encoder.encode("secret"),
      recipient.publicKey,
      context,
    );
    const tampered = new Uint8Array(envelope);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;

    for (const attempt of [
      () => open(tampered, recipient.privateKey, context),
      () => open(envelope, wrongRecipient.privateKey, context),
      () =>
        open(envelope, recipient.privateKey, encoder.encode("wrong-context")),
      () => open(Uint8Array.of(0xa0), recipient.privateKey, context),
    ])
      await expect(attempt()).rejects.toBeInstanceOf(InvalidCiphertextError);
  });

  test("preserves the canonical envelope registry and rejects unsupported suites", async () => {
    const recipient = await generateEncryptionKeyPair();
    const envelope = await seal(
      encoder.encode("registry"),
      recipient.publicKey,
    );
    const decoded = decodeCiphertextEnvelope(envelope);
    expect(encodeCiphertextEnvelope(decoded)).toEqual(envelope);

    const unsupported = new Map(decoded);
    unsupported.set(0, 2);
    await expect(
      open(canonicalEncode(unsupported), recipient.privateKey),
    ).rejects.toBeInstanceOf(InvalidCiphertextError);
  });

  test("signs and verifies Ed25519 messages with standard key encodings", async () => {
    const original = await generateSigningKeyPair();
    const publicKey = await importSigningPublicKey(
      await exportSigningPublicKey(original.publicKey),
    );
    const privateKey = await importSigningPrivateKey(
      await exportSigningPrivateKey(original.privateKey),
    );
    const message = encoder.encode("canonical revision bytes");
    const signature = await sign(message, privateKey);

    expect(signature.length).toBe(64);
    expect(await verify(message, signature, publicKey)).toBe(true);
    expect(await verify(encoder.encode("changed"), signature, publicKey)).toBe(
      false,
    );
  });

  test("uses SHA-384 through the Web Crypto API", async () => {
    expect(await sha384(encoder.encode("abc"))).toEqual(
      Uint8Array.from(
        Buffer.from(
          "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
          "hex",
        ),
      ),
    );
    expect(CRYPTO_SUITE.name).toBe("dotrelay-e2ee-v3-classical-webcrypto");
  });

  test("uses the canonical protocol signature input", async () => {
    const signing = await generateSigningKeyPair();
    const object = protocolObjectFromFields(
      1,
      new Map([
        [8, new Uint8Array(16)],
        [9, new Uint8Array(16)],
        [28, 1],
        [32, 1],
        [39, new Uint8Array(32)],
        [41, new Uint8Array(32)],
      ]),
    );
    const signature = await signProtocolObject(object, signing.privateKey);

    expect(
      await verifyProtocolObject(object, signature, signing.publicKey),
    ).toBe(true);
  });
});
