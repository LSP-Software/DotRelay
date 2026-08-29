import {
  createWrappingKey,
  unwrapBytes,
  wrapBytes,
  wrappingAssociatedData,
} from "@dotrelay/client";

const pin = Object.freeze({
  serverProfileId: "00000000-0000-0000-0000-000000000001",
  origin: "https://profile.example.test",
});

const dotRelayClientWrapRoundTrip = async () => {
  const runtime = globalThis.crypto;
  if (!runtime?.subtle) throw new TypeError("browser WebCrypto is unavailable");
  const deviceId = runtime.getRandomValues(new Uint8Array(16));
  const key = await createWrappingKey(runtime);
  const plaintext = runtime.getRandomValues(new Uint8Array(32));
  const associatedData = wrappingAssociatedData(pin, deviceId);
  const wrapped = await wrapBytes(key, plaintext, associatedData, runtime);
  const opened = await unwrapBytes(
    key,
    wrapped.iv,
    wrapped.ciphertext,
    associatedData,
    runtime,
  );
  const matches =
    opened.length === plaintext.length &&
    opened.every((byte, index) => byte === plaintext[index]);
  return Object.freeze({
    plaintextLength: plaintext.length,
    ciphertextLength: wrapped.ciphertext.length,
    matches,
  });
};

(
  globalThis as typeof globalThis & {
    dotRelayClientWrapRoundTrip: typeof dotRelayClientWrapRoundTrip;
  }
).dotRelayClientWrapRoundTrip = dotRelayClientWrapRoundTrip;

export { dotRelayClientWrapRoundTrip };
