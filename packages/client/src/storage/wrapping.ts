import type { ServerProfilePin } from "@dotrelay/contracts";

const utf8Encode = (value: string): Uint8Array =>
  new TextEncoder().encode(value);

import { zeroize } from "./types";

const WRAP_INFO = utf8Encode("DotRelay\0device-bundle-wrap\0v1\0");
const TAG_LENGTH = 128;

const asBufferSource = (input: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
};

export const wrappingAssociatedData = (
  pin: ServerProfilePin,
  deviceId: Uint8Array,
): Uint8Array => {
  const deviceHex = [...deviceId]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const suffix = utf8Encode(
    `${pin.serverProfileId}\0${pin.origin}\0${deviceHex}`,
  );
  const output = new Uint8Array(WRAP_INFO.length + suffix.length);
  output.set(WRAP_INFO);
  output.set(suffix, WRAP_INFO.length);
  return output;
};

export const createWrappingKey = async (
  runtime: Crypto = globalThis.crypto,
): Promise<CryptoKey> =>
  runtime.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);

export const wrapBytes = async (
  wrappingKey: CryptoKey,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
  runtime: Crypto = globalThis.crypto,
): Promise<Readonly<{ iv: Uint8Array; ciphertext: Uint8Array }>> => {
  const iv = runtime.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await runtime.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(iv),
        additionalData: asBufferSource(associatedData),
        tagLength: TAG_LENGTH,
      },
      wrappingKey,
      asBufferSource(plaintext),
    ),
  );
  return Object.freeze({ iv, ciphertext });
};

export const unwrapBytes = async (
  wrappingKey: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
  runtime: Crypto = globalThis.crypto,
): Promise<Uint8Array> => {
  try {
    const plaintext = new Uint8Array(
      await runtime.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: asBufferSource(iv),
          additionalData: asBufferSource(associatedData),
          tagLength: TAG_LENGTH,
        },
        wrappingKey,
        asBufferSource(ciphertext),
      ),
    );
    return plaintext;
  } catch {
    throw new Error("wrapped device bundle could not be decrypted");
  }
};

export const exportWrappingKeyMaterial = async (
  wrappingKey: CryptoKey,
  runtime: Crypto = globalThis.crypto,
): Promise<Uint8Array> => {
  try {
    return new Uint8Array(await runtime.subtle.exportKey("raw", wrappingKey));
  } catch {
    throw new Error("wrapping key is not exportable");
  }
};

export const importWrappingKeyMaterial = async (
  material: Uint8Array,
  extractable: boolean,
  runtime: Crypto = globalThis.crypto,
): Promise<CryptoKey> =>
  runtime.subtle.importKey(
    "raw",
    asBufferSource(material),
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );

export const wipeWrappingKey = async (
  wrappingKey: CryptoKey,
  runtime: Crypto = globalThis.crypto,
): Promise<void> => {
  if (!wrappingKey.extractable) return;
  let material: Uint8Array | undefined;
  try {
    material = await exportWrappingKeyMaterial(wrappingKey, runtime);
  } finally {
    zeroize(material);
  }
};
