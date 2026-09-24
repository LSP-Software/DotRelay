import { PASSKEY_PRF_OUTPUT_LENGTH } from "./constants";

// The WebAuthn `prf` extension lets a passkey contribute exactly 32 bytes of
// key material (HMAC-SHA256 over the application-provided 32-byte PRF input)
// without exposing the credential secret. WebAuthn Level 3 reports extension
// output through `PublicKeyCredential.getClientExtensionResults()`.
//
// Registration (`credentials.create`) reports `prf.enabled`. `enabled: true`
// means the new credential can evaluate the PRF. `results.first` may also be
// present when the creation request included `prf.eval`, but a result is not
// required at creation time. Authentication (`credentials.get`) does not
// report `enabled`. A successful evaluation is `prf.results.first`, a 32-byte
// ArrayBuffer. Neither response has a `supported` field.
//
// The output is ephemeral key-derivation material: it stays in this client
// and is fed to HKDF. It is never stored or sent to the service.

export type PrfEvaluationResults = Readonly<{
  readonly first?: ArrayBuffer;
  readonly second?: ArrayBuffer;
}>;

// Client extension output for `credentials.create`.
export type PrfRegistrationOutput = Readonly<{
  readonly enabled?: boolean;
  readonly results?: PrfEvaluationResults;
}>;

// Client extension output for `credentials.get`.
export type PrfAuthenticationOutput = Readonly<{
  readonly results?: PrfEvaluationResults;
}>;

// The minimal shape of a WebAuthn credential the account-key flows consume.
// `getClientExtensionResults` is the only platform method these flows call on
// a credential, and it is typed `() => unknown` because the browser hands
// back `AuthenticationExtensionsClientOutputs`, which carries no index
// signature; extractPasskeyPrfOutput accepts the same `unknown` and narrows
// the `prf` field. Kept structural (not the DOM `PublicKeyCredential` type)
// so the module stays free of browser type dependencies and can be driven by
// a faithful test double implementing the same real interface.
export type PasskeyCredential = Readonly<{
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: string;
  getClientExtensionResults(): unknown;
}>;

// A platform surface with enough of WebAuthn for the passkey PRF account-key
// flows: a `PublicKeyCredential` whose
// `isUserVerifyingPlatformAuthenticatorAvailable` method is the platform's
// own passkey capability probe, a `navigator.credentials` object with `get`,
// `create` (and optional `delete` for discarding a credential that cannot
// deliver the PRF), and `crypto` for the ceremony challenges. In the browser
// this is `globalThis`; tests pass a double conforming to this type. The
// public functions below accept a plain `object` (the DOM credential API is
// wider than this surface) and narrow each field before use, so no whole-
// platform cast is ever needed.
export type PasskeyPrfPlatform = Readonly<{
  readonly PublicKeyCredential: Readonly<{
    readonly isUserVerifyingPlatformAuthenticatorAvailable: () => Promise<boolean>;
  }>;
  readonly navigator: Readonly<{
    readonly credentials: Readonly<{
      readonly get: (
        options: Readonly<{ readonly publicKey: unknown }>,
      ) => Promise<PasskeyCredential>;
      readonly create: (
        options: Readonly<{ readonly publicKey: unknown }>,
      ) => Promise<PasskeyCredential>;
      readonly delete?: (
        options: Readonly<{ readonly publicKey: unknown }>,
      ) => Promise<unknown>;
    }>;
  }>;
  readonly crypto: Crypto;
}>;

// A credential `get`/`create`/`delete` as the DOM exposes it, widened to the
// generic options surface so the real platform API can be stored without a
// cast at the call site.
type CredentialMethod = (
  options: Readonly<{ readonly publicKey: unknown }>,
) => Promise<unknown>;

type ProbedCredentialApi = Readonly<{
  readonly get: CredentialMethod;
  readonly create: CredentialMethod;
  readonly delete?: CredentialMethod;
}>;

const prfExtension = (
  clientExtensionResults: unknown,
): Record<string, unknown> | null => {
  if (
    typeof clientExtensionResults !== "object" ||
    clientExtensionResults === null
  )
    return null;
  const prf = (clientExtensionResults as Record<string, unknown>)["prf"];
  if (typeof prf !== "object" || prf === null) return null;
  return prf as Record<string, unknown>;
};

// Registration reports `enabled: true` only when the created credential can
// evaluate the PRF. Authentication does not report this field.
const prfRegistrationEnabled = (clientExtensionResults: unknown): boolean =>
  prfExtension(clientExtensionResults)?.["enabled"] === true;

// Read `prf.results.first` from a credential's client extension results.
// Returns null when the result is absent or is not a 32-byte ArrayBuffer.
// Callers treat null as "PRF output unavailable" and fall back to the
// password or recovery-code path. `enabled` and any non-standard `supported`
// flag are ignored here: authentication success is the result bytes alone.
export const extractPasskeyPrfOutput = (
  clientExtensionResults: unknown,
): Uint8Array | null => {
  const prf = prfExtension(clientExtensionResults);
  if (!prf || !("results" in prf)) return null;
  const inner = prf["results"];
  if (typeof inner !== "object" || inner === null) return null;
  const first = (inner as Record<string, unknown>)["first"];
  if (!(first instanceof ArrayBuffer)) return null;
  if (first.byteLength !== PASSKEY_PRF_OUTPUT_LENGTH) return null;
  return new Uint8Array(first);
};

// Narrow the WebAuthn capability fields from a possibly-bare platform object
// (e.g. `globalThis`). Returns null when any required capability is missing,
// so the caller can report the platform as unavailable instead of casting.
const probeCredentialApi = (platform: object): ProbedCredentialApi | null => {
  const surface = platform as Record<string, unknown>;
  const publicKeyCredential = surface["PublicKeyCredential"];
  // `PublicKeyCredential` is a constructor, so its type is "function" in the
  // real browser; the fake in tests may present it as a plain object.
  if (
    (typeof publicKeyCredential !== "object" &&
      typeof publicKeyCredential !== "function") ||
    publicKeyCredential === null
  )
    return null;
  const probe = publicKeyCredential as Record<string, unknown>;
  if (
    typeof probe["isUserVerifyingPlatformAuthenticatorAvailable"] !== "function"
  )
    return null;
  const navigator = surface["navigator"];
  if (typeof navigator !== "object" || navigator === null) return null;
  const credentials = (navigator as Record<string, unknown>)["credentials"];
  if (typeof credentials !== "object" || credentials === null) return null;
  const api = credentials as Record<string, unknown>;
  const get = api["get"];
  const create = api["create"];
  if (typeof get !== "function" || typeof create !== "function") return null;
  const probed: {
    get: CredentialMethod;
    create: CredentialMethod;
    delete?: CredentialMethod;
  } = { get: get as CredentialMethod, create: create as CredentialMethod };
  const del = api["delete"];
  if (typeof del === "function") probed.delete = del as CredentialMethod;
  return Object.freeze(probed);
};

// Narrow the `crypto` object a ceremony needs for challenges, or null.
const probeCrypto = (platform: object): Crypto | null => {
  const surface = platform as Record<string, unknown>;
  const crypto = surface["crypto"];
  if (typeof crypto !== "object" || crypto === null) return null;
  if (
    typeof (crypto as Record<string, unknown>)["getRandomValues"] !== "function"
  )
    return null;
  return crypto as Crypto;
};

// Best-effort platform feature detection for the WebAuthn PRF extension. A
// platform that exposes `PublicKeyCredential` and a `navigator.credentials`
// object with `get` and `create` can request the extension during an
// assertion (unlock) and during credential creation (adding a passkey);
// whether a concrete passkey actually returns a PRF output is confirmed
// per-assertion via extractPasskeyPrfOutput. Returns false when the passkey
// PRF path is unavailable and the caller should offer the password or
// recovery-code path instead.
export const passkeyPrfSupported = (platform: object = globalThis): boolean =>
  probeCredentialApi(platform) !== null;

// Classifies a WebAuthn platform failure for the account-key flows. Each
// code maps to an honest, distinct user-facing message: a prompt the User
// walked away from (NotAllowedError) is a cancellation, not a failed attempt;
// an authenticator that cannot evaluate the PRF is "unsupported"; a missing
// platform capability is "unavailable".
export type PasskeyPrfErrorCode =
  | "cancelled"
  | "unsupported"
  | "no-matching-credential"
  | "platform-unavailable"
  | "other";

export class PasskeyPrfError extends Error {
  readonly code: PasskeyPrfErrorCode;

  constructor(code: PasskeyPrfErrorCode) {
    const messages: Record<PasskeyPrfErrorCode, string> = {
      cancelled: "The passkey prompt was cancelled; nothing changed.",
      unsupported:
        "This passkey can't generate the key material the account needs, so it can't unlock it. Use your recovery code or password instead.",
      "no-matching-credential":
        "No matching passkey is available on this device for this account. Unlock with your recovery code or password, or add the passkey again.",
      "platform-unavailable":
        "This browser's passkey capability is currently unavailable. Unlock with your recovery code or password instead.",
      other: "The passkey prompt failed. Try again.",
    };
    super(messages[code]);
    this.name = "PasskeyPrfError";
    this.code = code;
  }
}

const nameOf = (error: unknown): string => {
  if (error instanceof Error) return error.name;
  if (typeof error === "object" && error !== null && "name" in error) {
    if (typeof error.name === "string") return error.name;
  }
  return "";
};

const classifyPasskeyFailure = (error: unknown): PasskeyPrfError => {
  const name = nameOf(error);
  if (name === "NotAllowedError") return new PasskeyPrfError("cancelled");
  if (name === "CredentialNotAllowedError")
    return new PasskeyPrfError("no-matching-credential");
  if (name === "SecurityError")
    return new PasskeyPrfError("platform-unavailable");
  return new PasskeyPrfError("other");
};

const asBufferSource = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

// Normalize whatever the platform's `get`/`create` resolved (the DOM returns
// `Credential | null`; a test double returns its own shape) to the minimal
// credential surface the flows consume. Returns null when the result is not
// a credential that can report client extension results.
const toPasskeyCredential = (credential: unknown): PasskeyCredential | null => {
  if (typeof credential !== "object" || credential === null) return null;
  const surface = credential as Record<string, unknown>;
  const readResults = surface["getClientExtensionResults"];
  if (typeof readResults !== "function") return null;
  const read = readResults as (this: unknown) => unknown;
  const rawId = surface["rawId"];
  const id = surface["id"];
  const type = surface["type"];
  return Object.freeze({
    id: typeof id === "string" ? id : "",
    rawId: rawId instanceof ArrayBuffer ? rawId : new ArrayBuffer(0),
    type: typeof type === "string" ? type : "public-key",
    getClientExtensionResults: () => read.call(credential),
  });
};

// The public-key options for a PRF assertion over the stored PRF input: a
// fresh 32-byte challenge, the credential allow-list, and the Level 3 PRF
// extension input `{ prf: { eval: { first } } }`.
const prfAssertionOptions = (
  crypto: Crypto,
  credentialIdBytes: Uint8Array,
  prfInput: Uint8Array,
): Readonly<{ readonly publicKey: unknown }> => {
  const input = new Uint8Array(prfInput);
  if (input.length !== 32)
    throw new TypeError("passkey PRF input must be 32 bytes");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  return Object.freeze({
    publicKey: {
      challenge: asBufferSource(challenge),
      allowCredentials: [
        {
          id: asBufferSource(new Uint8Array(credentialIdBytes)),
          type: "public-key",
          transports: ["internal", "hybrid"],
        },
      ],
      userVerification: "required",
      extensions: { prf: { eval: { first: asBufferSource(input) } } },
    },
  });
};

// Ask the platform to evaluate the stored passkey's PRF over a 32-byte input
// during a real assertion. The assertion is a genuine authentication
// ceremony: the user verifies to their authenticator, the PRF input rides
// with the request, and the 32-byte result is read back from
// `getClientExtensionResults().prf.results.first`. The credential response is
// never serialized or transmitted: only the wrapper bytes (which carry the
// PRF input, never the output) reach the service.
//
// Throws PasskeyPrfError when the prompt is cancelled, no matching credential
// is available, the platform is unavailable, or the stored credential cannot
// deliver the PRF, so the caller can report each honestly.
export const runPasskeyAssertion = async (
  platform: object,
  credentialIdBytes: Uint8Array,
  prfInput: Uint8Array,
): Promise<Uint8Array> => {
  const credentials = probeCredentialApi(platform);
  const crypto = probeCrypto(platform);
  if (!credentials || !crypto)
    return Promise.reject(new PasskeyPrfError("platform-unavailable"));
  let result: unknown;
  try {
    result = await credentials.get(
      prfAssertionOptions(crypto, credentialIdBytes, prfInput),
    );
  } catch (error) {
    throw classifyPasskeyFailure(error);
  }
  const assertion = toPasskeyCredential(result);
  if (!assertion)
    return Promise.reject(new PasskeyPrfError("no-matching-credential"));
  const output = extractPasskeyPrfOutput(assertion.getClientExtensionResults());
  if (!output) return Promise.reject(new PasskeyPrfError("unsupported"));
  return output;
};

const discardPasskey = async (
  credentials: ProbedCredentialApi,
  rawId: ArrayBuffer,
): Promise<void> => {
  try {
    await credentials.delete?.({
      publicKey: {
        allowCredentials: [
          {
            id: rawId,
            type: "public-key",
            transports: ["internal", "hybrid"],
          },
        ],
      },
    });
  } catch {
    // best effort: a credential that cannot deliver the PRF cannot unlock
    // the account anyway
  }
};

// Create a passkey and require WebAuthn Level 3 `prf.enabled === true`.
// A creation-time `results.first` is used when the authenticator supplied
// one. Otherwise a real assertion must return `results.first`. `enabled:
// false` is discarded and is not registered. The credential and its
// extension output stay in this client: only the wrapper bytes, which carry
// the PRF input and not the output, reach the service.
//
// On success the caller derives the wrapper's key from the returned PRF
// output and wraps the existing Account Master Key under it. The credential
// and its response are never serialized or transmitted: only the resulting
// wrapper bytes reach the service.
export const createPasskeyWithPrf = async (
  platform: object,
  prfInput: Uint8Array,
  userIdBytes: Uint8Array,
): Promise<
  Readonly<{
    readonly credentialId: Uint8Array;
    readonly prfOutput: Uint8Array;
  }>
> => {
  const credentials = probeCredentialApi(platform);
  const crypto = probeCrypto(platform);
  if (!credentials || !crypto)
    return Promise.reject(new PasskeyPrfError("platform-unavailable"));
  const input = new Uint8Array(prfInput);
  if (input.length !== 32)
    throw new TypeError("passkey PRF input must be 32 bytes");
  const userId =
    userIdBytes.length > 0
      ? new Uint8Array(userIdBytes)
      : crypto.getRandomValues(new Uint8Array(16));
  let created: unknown;
  try {
    created = await credentials.create({
      publicKey: {
        challenge: asBufferSource(crypto.getRandomValues(new Uint8Array(32))),
        rp: { name: "DotRelay" },
        user: {
          id: asBufferSource(userId),
          name: "dotrelay",
          displayName: "DotRelay",
        },
        pubKeyCredParams: [{ alg: -8, type: "public-key" }],
        attestation: "none",
        timeout: 60_000,
        authenticatorSelection: {
          userVerification: "required",
        },
        extensions: { prf: { eval: { first: asBufferSource(input) } } },
      },
    });
  } catch (error) {
    throw classifyPasskeyFailure(error);
  }
  const newCredential = toPasskeyCredential(created);
  if (!newCredential) throw new PasskeyPrfError("unsupported");
  const creationResults = newCredential.getClientExtensionResults();
  // `enabled: false`, or a creation response that does not report `enabled`,
  // is not a usable recovery method. An immediate result is not enough, and
  // a later assertion must not promote it.
  if (!prfRegistrationEnabled(creationResults)) {
    await discardPasskey(credentials, newCredential.rawId);
    throw new PasskeyPrfError("unsupported");
  }
  const createdOutput = extractPasskeyPrfOutput(creationResults);
  if (createdOutput)
    return Object.freeze({
      credentialId: new Uint8Array(newCredential.rawId),
      prfOutput: createdOutput,
    });
  // `enabled: true` with no creation-time result. Confirm with a real
  // assertion. If that also fails, the authenticator cannot deliver PRF
  // outputs, so discard the credential.
  let confirmation: PasskeyCredential | null = null;
  try {
    const confirmationResult: unknown = await credentials.get(
      prfAssertionOptions(crypto, new Uint8Array(newCredential.rawId), input),
    );
    confirmation = toPasskeyCredential(confirmationResult);
  } catch {
    confirmation = null;
  }
  if (confirmation) {
    const confirmed = extractPasskeyPrfOutput(
      confirmation.getClientExtensionResults(),
    );
    if (confirmed)
      return Object.freeze({
        credentialId: new Uint8Array(newCredential.rawId),
        prfOutput: confirmed,
      });
  }
  await discardPasskey(credentials, newCredential.rawId);
  throw new PasskeyPrfError("unsupported");
};
