import {
  exportEncryptionPrivateKey,
  exportEncryptionPublicKey,
  exportSigningPrivateKey,
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  importEncryptionPrivateKey,
  importEncryptionPublicKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  open,
  seal,
  sign,
  verify,
} from "@dotrelay/contracts";

type CryptoBrowserResult = Readonly<{
  readonly encryptionRoundTrip: boolean;
  readonly signingRoundTrip: boolean;
  readonly signatureLength: number;
  readonly ciphertextLength: number;
  readonly freshRandomness: boolean;
}>;

export const runCryptoRoundTrip = async (): Promise<CryptoBrowserResult> => {
  const encoder = new TextEncoder();
  const message = encoder.encode("browser/Bun parity");
  const context = encoder.encode("project:browser/environment:test");
  const encryption = await generateEncryptionKeyPair();
  const publicKey = await importEncryptionPublicKey(
    await exportEncryptionPublicKey(encryption.publicKey),
  );
  const privateKey = await importEncryptionPrivateKey(
    await exportEncryptionPrivateKey(encryption.privateKey),
  );
  const first = await seal(message, publicKey, context);
  const second = await seal(message, publicKey, context);
  const plaintext = await open(first, privateKey, context);
  const signing = await generateSigningKeyPair();
  const signingPublicKey = await importSigningPublicKey(
    await exportSigningPublicKey(signing.publicKey),
  );
  const signingPrivateKey = await importSigningPrivateKey(
    await exportSigningPrivateKey(signing.privateKey),
  );
  const signature = await sign(message, signingPrivateKey);

  return {
    encryptionRoundTrip: plaintext.every(
      (byte, index) => byte === message[index],
    ),
    signingRoundTrip: await verify(message, signature, signingPublicKey),
    signatureLength: signature.length,
    ciphertextLength: first.length,
    freshRandomness: first.some(
      (byte, index) => byte !== (second[index] ?? byte),
    ),
  };
};

(
  globalThis as typeof globalThis & {
    dotRelayCryptoRoundTrip: () => Promise<CryptoBrowserResult>;
  }
).dotRelayCryptoRoundTrip = runCryptoRoundTrip;
