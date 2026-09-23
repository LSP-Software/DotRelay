(() => {
  const mode = globalThis.__dotrelayPasskeyMode ?? "prf";
  const stableCredentialId = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  ]);

  const asBytes = (value) => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return new Uint8Array();
  };

  const copyBuffer = (value) => {
    const bytes = asBytes(value);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  };

  const record = (value) =>
    typeof value === "object" && value !== null ? value : null;

  const readPrfInput = (options) => {
    const request = record(options);
    const publicKey = record(request?.publicKey);
    const extensions = record(publicKey?.extensions);
    const prf = record(extensions?.prf);
    const evaluation = record(prf?.eval);
    return asBytes(evaluation?.first);
  };

  const readCredentialId = (options) => {
    const request = record(options);
    const publicKey = record(request?.publicKey);
    const allowCredentials = publicKey?.allowCredentials;
    if (!Array.isArray(allowCredentials) || allowCredentials.length === 0)
      return stableCredentialId;
    const id = asBytes(record(allowCredentials[0])?.id);
    return id.byteLength > 0 ? id : stableCredentialId;
  };

  const digest = async (credentialId, input) => {
    const joined = new Uint8Array(credentialId.byteLength + input.byteLength);
    joined.set(credentialId, 0);
    joined.set(input, credentialId.byteLength);
    return crypto.subtle.digest("SHA-256", joined);
  };

  class FakePublicKeyCredential {
    constructor(rawId, extensionResults) {
      this.id = "dotrelay-simulated-passkey";
      this.rawId = rawId;
      this.response = {};
      this.type = "public-key";
      this.extensionResults = extensionResults;
    }

    getClientExtensionResults() {
      return this.extensionResults;
    }

    static isUserVerifyingPlatformAuthenticatorAvailable() {
      return Promise.resolve(true);
    }
  }

  const unsupportedCredential = (credentialId) =>
    new FakePublicKeyCredential(copyBuffer(credentialId), {
      prf: { supported: false },
    });

  const credentialFor = async (credentialId, input) => {
    if (mode === "unsupported" || input.byteLength !== 32)
      return unsupportedCredential(credentialId);
    return new FakePublicKeyCredential(copyBuffer(credentialId), {
      prf: {
        supported: true,
        results: { first: await digest(credentialId, input) },
      },
    });
  };

  const credentials = {
    create: async (options) => {
      if (mode === "cancelled")
        throw new DOMException(
          "The operation was cancelled.",
          "NotAllowedError",
        );
      if (mode === "unsupported")
        return unsupportedCredential(stableCredentialId);
      return credentialFor(stableCredentialId, readPrfInput(options));
    },
    delete: async () => {
      globalThis.__dotrelayPasskeyDeleted += 1;
    },
    get: async (options) => {
      if (mode === "cancelled")
        throw new DOMException(
          "The operation was cancelled.",
          "NotAllowedError",
        );
      return credentialFor(readCredentialId(options), readPrfInput(options));
    },
  };

  globalThis.PublicKeyCredential = FakePublicKeyCredential;
  globalThis.__dotrelayPasskeyDeleted = 0;
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: credentials,
  });
})();
