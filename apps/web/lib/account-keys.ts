import {
  type AccountKeyTrustedKeys,
  type AccountKeyVerificationContext,
  type AccountKeyWrapper,
  decodeRecoveryCode,
  openAccountKeyEnvelope,
  openAccountKeyTransfer,
  type ProtocolObject,
  parseAccountKeyEnvelope,
  parseAccountKeyTransfer,
  parseAccountKeyWrapper,
  unwrapAccountKeyWrapper,
} from "@dotrelay/client";
import { canonicalEncode, sha384, uuidToBytes } from "@dotrelay/contracts";
import type { WorkspaceBoundary } from "./workspace-boundary";

// Browser-side client for the account-key protocol routes
// (/api/v1/account-keys/*). The routes authenticate a session PLUS an active
// browser Device (X-DotRelay-Device-Id), and every mutation needs an
// Idempotency-Key that equals body.operationId. Callers keep the
// operationId stable across retries of the same logical attempt so a failed
// commit replays instead of double-publishing.
//
// The browser never stores the Account Master Key: the caller (the
// workspace shell) keeps it in memory for the page session, so a reload
// returns the user to a locked state they re-enter through one of the
// wrappers (or a transfer from another Device).

export type AccountKeyActor = Readonly<{
  readonly origin: string;
  readonly deviceId: string;
}>;

export type AccountKeyWrapperEntry = Readonly<{
  readonly wrapperId: string;
  readonly type: "recovery-code" | "password" | "passkey-prf";
  readonly object: string;
  readonly creatorDeviceId?: string;
  readonly creatorPublicKey?: string;
  readonly kdf?: Readonly<{
    readonly memoryKib: string | null;
    readonly iterations: string | null;
    readonly parallelism: number | null;
  }>;
  readonly createdAt: string;
}>;

export class AccountKeyRequestError extends Error {
  readonly code: string | null;
  constructor(code: string | null, message: string) {
    super(message);
    this.name = "AccountKeyRequestError";
    this.code = code;
  }
}

const toBase64 = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const bytesToHex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const hexToBytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

export const sha384ToHex = async (value: Uint8Array): Promise<string> =>
  bytesToHex(await sha384(value));

const readProblemCode = async (response: Response): Promise<string | null> => {
  try {
    const body = (await response.json()) as { readonly code?: unknown };
    return typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
};

const jsonPost = async (
  actor: AccountKeyActor,
  path: string,
  operationId: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${actor.origin}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-DotRelay-Device-Id": actor.deviceId,
      "Idempotency-Key": operationId,
    },
    body: JSON.stringify({ ...body, operationId }),
  });
  if (!response.ok)
    throw new AccountKeyRequestError(
      await readProblemCode(response),
      "The server rejected the request.",
    );
  return (await response.json()) as Record<string, unknown>;
};

const fetchJson = async (
  actor: AccountKeyActor,
  path: string,
): Promise<Record<string, unknown>> => {
  const response = await fetch(`${actor.origin}${path}`, {
    credentials: "include",
    headers: { "X-DotRelay-Device-Id": actor.deviceId },
    cache: "no-store",
  });
  if (!response.ok)
    throw new AccountKeyRequestError(
      await readProblemCode(response),
      "The server rejected the request.",
    );
  return (await response.json()) as Record<string, unknown>;
};

// GET /api/v1/account-keys/wrappers — the non-retired wrappers for the
// actor's account, oldest first.
export const fetchAccountKeyWrappers = async (
  actor: AccountKeyActor,
): Promise<readonly AccountKeyWrapperEntry[]> => {
  const body = await fetchJson(actor, "/api/v1/account-keys/wrappers");
  const wrappers = body.wrappers;
  if (!Array.isArray(wrappers))
    throw new Error("the wrapper list is malformed");
  const entries: AccountKeyWrapperEntry[] = [];
  for (const raw of wrappers) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    if (
      typeof candidate.wrapperId !== "string" ||
      typeof candidate.object !== "string" ||
      typeof candidate.createdAt !== "string"
    )
      continue;
    const kdf = (candidate.kdf ?? null) as Record<string, unknown> | null;
    entries.push(
      Object.freeze({
        wrapperId: candidate.wrapperId,
        type:
          candidate.type === "passkey-prf"
            ? "passkey-prf"
            : candidate.type === "password"
              ? "password"
              : "recovery-code",
        object: candidate.object,
        ...(typeof candidate.creatorDeviceId === "string"
          ? { creatorDeviceId: candidate.creatorDeviceId }
          : {}),
        ...(typeof candidate.creatorPublicKey === "string"
          ? { creatorPublicKey: candidate.creatorPublicKey }
          : {}),
        ...(kdf
          ? {
              kdf: Object.freeze({
                memoryKib:
                  typeof kdf.memoryKib === "string" ? kdf.memoryKib : null,
                iterations:
                  typeof kdf.iterations === "string" ? kdf.iterations : null,
                parallelism:
                  typeof kdf.parallelism === "number" ? kdf.parallelism : null,
              }),
            }
          : {}),
        createdAt: candidate.createdAt,
      }),
    );
  }
  return Object.freeze(entries);
};

// POST /api/v1/account-keys/wrappers — add an Account Key Wrapper. Publishing
// a RECOVERY_CODE wrapper retires the account's prior active one, which is
// how rotation is expressed: the old code stops working when the new commit
// lands.
export const publishAccountKeyWrapper = async (
  actor: AccountKeyActor,
  operationId: string,
  wrapper: AccountKeyWrapper,
  identityGeneration: string,
): Promise<Readonly<{ readonly idempotent: boolean }>> => {
  const body = await jsonPost(
    actor,
    "/api/v1/account-keys/wrappers",
    operationId,
    {
      objectId: globalThis.crypto.randomUUID(),
      object: toBase64(canonicalEncode(wrapper.object)),
      wrapperId: bytesToHex(wrapper.wrapperId),
      identityGeneration,
      ciphertextHash: await sha384ToHex(wrapper.ciphertext),
      ciphertextLength: wrapper.ciphertext.length,
    },
  );
  return Object.freeze({ idempotent: body.idempotent === true });
};

// POST /api/v1/account-keys/wrappers/revoke — retire a wrapper. The server
// refuses (state_conflict) when it is the account's last active
// RECOVERY_CODE wrapper, so some unlock path always remains.
export const revokeAccountKeyWrapper = async (
  actor: AccountKeyActor,
  operationId: string,
  wrapperIdHex: string,
): Promise<
  Readonly<{ readonly revoked: boolean; readonly idempotent: boolean }>
> => {
  const body = await jsonPost(
    actor,
    "/api/v1/account-keys/wrappers/revoke",
    operationId,
    { wrapperId: wrapperIdHex.toLowerCase() },
  );
  return Object.freeze({
    revoked: body.revoked === true,
    idempotent: body.idempotent === true,
  });
};

// POST /api/v1/account-keys/envelopes — publish an Account Key Envelope
// (kind 21) so the User's other Devices can open the content key with the
// Account Master Key instead of a per-Device grant.
export const publishAccountKeyEnvelope = async (
  actor: AccountKeyActor,
  operationId: string,
  envelope: Readonly<{
    readonly object: ProtocolObject;
    readonly ciphertext: Uint8Array;
  }>,
  target: Readonly<{
    readonly envelopeType: "PROJECT_EPOCH_KEY" | "USER_VALUE_KEY";
    readonly projectId?: string;
    readonly projectEpoch?: number;
    readonly ownerUserId?: string;
    readonly valueGeneration?: number;
  }>,
): Promise<Readonly<{ readonly idempotent: boolean }>> => {
  const body = await jsonPost(
    actor,
    "/api/v1/account-keys/envelopes",
    operationId,
    {
      objectId: globalThis.crypto.randomUUID(),
      object: toBase64(canonicalEncode(envelope.object)),
      ciphertextHash: await sha384ToHex(envelope.ciphertext),
      ciphertextLength: envelope.ciphertext.length,
      ...(target.envelopeType === "PROJECT_EPOCH_KEY"
        ? {
            projectId: target.projectId,
            projectEpoch: String(target.projectEpoch),
          }
        : {
            ownerUserId: target.ownerUserId,
            valueGeneration: String(target.valueGeneration),
          }),
    },
  );
  return Object.freeze({ idempotent: body.idempotent === true });
};

// POST /api/v1/account-keys/transfers — stage an Account Key Transfer sealed
// to one recipient Device. The recipient redeems it with
// /api/v1/account-keys/transfers/:id/accept before it expires.
export const stageAccountKeyTransfer = async (
  actor: AccountKeyActor,
  operationId: string,
  transfer: Readonly<{
    readonly object: ProtocolObject;
    readonly transferId: Uint8Array;
  }>,
  target: Readonly<{
    readonly recipientDeviceId: string;
    readonly expiresAt: string;
  }>,
): Promise<
  Readonly<{
    readonly transferId: string;
    readonly recipientDeviceId: string;
    readonly expiresAt: string;
    readonly idempotent: boolean;
  }>
> => {
  const body = await jsonPost(
    actor,
    "/api/v1/account-keys/transfers",
    operationId,
    {
      objectId: globalThis.crypto.randomUUID(),
      object: toBase64(canonicalEncode(transfer.object)),
      recipientDeviceId: target.recipientDeviceId,
      transferId: bytesToHex(transfer.transferId),
      expiresAt: target.expiresAt,
      ciphertextHash: await sha384ToHex(transfer.object.get(48) as Uint8Array),
      ciphertextLength: Number(transfer.object.get(72)),
    },
  );
  return Object.freeze({
    transferId: typeof body.transferId === "string" ? body.transferId : "",
    recipientDeviceId:
      typeof body.recipientDeviceId === "string" ? body.recipientDeviceId : "",
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
    idempotent: body.idempotent === true,
  });
};

// POST /api/v1/account-keys/transfers/:transferId/accept — redeem a transfer
// sealed to this actor's Device. The response carries the transfer object
// (and its creator Device's public key) for local verification.
export const acceptAccountKeyTransfer = async (
  actor: AccountKeyActor,
  transferIdHex: string,
): Promise<
  Readonly<{ readonly object: string; readonly creatorPublicKey?: string }>
> => {
  const body = await jsonPost(
    actor,
    `/api/v1/account-keys/transfers/${transferIdHex.toLowerCase()}/accept`,
    globalThis.crypto.randomUUID(),
    {},
  );
  if (typeof body.object !== "string")
    throw new Error("the transfer response is malformed");
  return Object.freeze({
    object: body.object,
    ...(typeof body.creatorPublicKey === "string"
      ? { creatorPublicKey: body.creatorPublicKey }
      : {}),
  });
};

// The trust set an account-key object's signature is checked against: the
// local Device's signing key, the boundary's Team trust keys and Devices,
// the boundary's own Device key, and every peer Device key. API responses
// may additionally name a creator Device's public key (extraKeys), since a
// wrapper, envelope, or transfer can be created by any of the User's
// Devices. Mirrors accountKeyTrustedKeys in apps/cli/src/workflow.ts.
export const accountKeyTrustedKeys = (
  boundary: WorkspaceBoundary,
  localSigningPublicKey: Uint8Array,
  extraKeys: readonly string[] = [],
): AccountKeyTrustedKeys => {
  const keys: Uint8Array[] = [localSigningPublicKey];
  const seen = new Set<string>([bytesToHex(localSigningPublicKey)]);
  const addHex = (value: string): void => {
    try {
      const bytes = hexToBytes(value);
      const hex = bytesToHex(bytes);
      if (seen.has(hex)) return;
      seen.add(hex);
      keys.push(bytes);
    } catch {
      // ignore malformed keys
    }
  };
  for (const device of boundary.signingTrustDevices ?? [])
    addHex(device.signingPublicKey);
  for (const key of boundary.signingTrustKeys ?? []) addHex(key);
  if (boundary.device.signingPublicKey)
    addHex(boundary.device.signingPublicKey);
  for (const peer of boundary.peerDevices ?? [])
    if (peer.signingPublicKey.length > 0) addHex(peer.signingPublicKey);
  for (const key of extraKeys) addHex(key);
  return Object.freeze({ keys });
};

// The identity fields every account-key object in this workspace is bound
// to: the Server Profile and the User. Device-scoped fields (deviceId,
// userIdentityGeneration) are signature-authenticated creator fields, so the
// opener does not pin them (mirrors the CLI).
export const accountKeyVerificationContext = (
  boundary: WorkspaceBoundary,
): AccountKeyVerificationContext => ({
  serverProfileId: uuidToBytes(boundary.profile.serverProfileId ?? ""),
  ...(boundary.session.userId
    ? { userId: uuidToBytes(boundary.session.userId) }
    : {}),
});

// Every failure to open a wrapper or transfer maps to one uniform message:
// a wrong secret, a retired code, and a tampered object are indistinguishable
// on purpose, so the UI never leaks which of its checks rejected the attempt.
const UNLOCK_FAILURE =
  "We couldn't unlock your account with that. Check the input and try again.";

const unwrapError = (): Error => new Error(UNLOCK_FAILURE);

// Recovery Code path: decode the 13×4 code, verify the wrapper's signature
// against the trust set, then derive the KEK directly from the code (no KDF).
export const unlockWithRecoveryCode = async (
  wrapperEntry: AccountKeyWrapperEntry,
  codeText: string,
  verification: Readonly<{
    readonly trustedKeys: AccountKeyTrustedKeys;
    readonly context: AccountKeyVerificationContext;
  }>,
): Promise<Readonly<{ readonly accountMasterKey: Uint8Array }>> => {
  let code: Uint8Array;
  let wrapper: ReturnType<typeof parseAccountKeyWrapper>;
  try {
    code = decodeRecoveryCode(codeText.trim());
    wrapper = parseAccountKeyWrapper(fromBase64(wrapperEntry.object));
  } catch {
    throw unwrapError();
  }
  try {
    const accountMasterKey = await unwrapAccountKeyWrapper(
      wrapper,
      { recoveryCode: code },
      { trustedKeys: verification.trustedKeys, context: verification.context },
    );
    return Object.freeze({ accountMasterKey });
  } catch {
    throw unwrapError();
  }
};

// Encryption Password path: the wrapper's stored Argon2id parameters drive
// the KDF (validated against the policy before any allocation).
export const unlockWithPassword = async (
  wrapperEntry: AccountKeyWrapperEntry,
  password: string,
  verification: Readonly<{
    readonly trustedKeys: AccountKeyTrustedKeys;
    readonly context: AccountKeyVerificationContext;
  }>,
): Promise<Readonly<{ readonly accountMasterKey: Uint8Array }>> => {
  let wrapper: ReturnType<typeof parseAccountKeyWrapper>;
  try {
    wrapper = parseAccountKeyWrapper(fromBase64(wrapperEntry.object));
  } catch {
    throw unwrapError();
  }
  try {
    const accountMasterKey = await unwrapAccountKeyWrapper(
      wrapper,
      { password: new TextEncoder().encode(password) },
      { trustedKeys: verification.trustedKeys, context: verification.context },
    );
    return Object.freeze({ accountMasterKey });
  } catch {
    throw unwrapError();
  }
};

// Passkey path: the caller runs the WebAuthn assertion with the wrapper's
// stored PRF input and hands over the 32-byte PRF output.
export const unlockWithPasskeyPrf = async (
  wrapperEntry: AccountKeyWrapperEntry,
  prfOutput: Uint8Array,
  verification: Readonly<{
    readonly trustedKeys: AccountKeyTrustedKeys;
    readonly context: AccountKeyVerificationContext;
  }>,
): Promise<Readonly<{ readonly accountMasterKey: Uint8Array }>> => {
  let wrapper: ReturnType<typeof parseAccountKeyWrapper>;
  try {
    wrapper = parseAccountKeyWrapper(fromBase64(wrapperEntry.object));
  } catch {
    throw unwrapError();
  }
  try {
    const accountMasterKey = await unwrapAccountKeyWrapper(
      wrapper,
      { prfOutput },
      { trustedKeys: verification.trustedKeys, context: verification.context },
    );
    return Object.freeze({ accountMasterKey });
  } catch {
    throw unwrapError();
  }
};

// Transfer path: the caller redeemed the transfer via accept; this opens the
// X25519 envelope sealed to the actor's Device key after binding the
// transfer to that Device and its expiry window.
export const openAccountKeyTransferForDevice = async (
  transferObjectB64: string,
  recipientX25519PrivateKey: CryptoKey,
  verification: Readonly<{
    readonly trustedKeys: AccountKeyTrustedKeys;
    readonly context: AccountKeyVerificationContext;
    readonly ownDeviceId: Uint8Array;
    readonly nowMs: number;
  }>,
): Promise<Readonly<{ readonly accountMasterKey: Uint8Array }>> => {
  let transfer: ReturnType<typeof parseAccountKeyTransfer>;
  try {
    transfer = parseAccountKeyTransfer(fromBase64(transferObjectB64));
  } catch {
    throw unwrapError();
  }
  try {
    const accountMasterKey = await openAccountKeyTransfer(
      transfer,
      recipientX25519PrivateKey,
      {
        trustedKeys: verification.trustedKeys,
        context: {
          ...verification.context,
          ownDeviceId: verification.ownDeviceId,
          nowMs: verification.nowMs,
        },
      },
    );
    return Object.freeze({ accountMasterKey });
  } catch {
    throw unwrapError();
  }
};

// The boundary's Account Key Envelope for the open Project Epoch, when it
// matches this Project and epoch: the content key is the shared Value
// secret, letting a freshly-unlocked Device read pre-existing content
// without help from any existing Device. A mismatch or failure yields
// null — the caller then falls back to the epoch grant or the self-mint
// path.
export const openProjectEpochEnvelope = async (
  envelopeB64: string | undefined,
  accountMasterKey: Uint8Array,
  verification: Readonly<{
    readonly trustedKeys: AccountKeyTrustedKeys;
    readonly context: AccountKeyVerificationContext;
    readonly projectId: string;
    readonly projectEpoch: number;
  }>,
): Promise<Uint8Array | null> => {
  if (!envelopeB64) return null;
  let envelope: ReturnType<typeof parseAccountKeyEnvelope>;
  try {
    envelope = parseAccountKeyEnvelope(fromBase64(envelopeB64));
  } catch {
    return null;
  }
  if (
    envelope.envelopeType !== 1 ||
    envelope.projectId === undefined ||
    envelope.projectEpoch === undefined ||
    bytesToHex(envelope.projectId) !==
      bytesToHex(uuidToBytes(verification.projectId)) ||
    envelope.projectEpoch !== verification.projectEpoch
  )
    return null;
  try {
    return await openAccountKeyEnvelope(envelope, accountMasterKey, {
      trustedKeys: verification.trustedKeys,
      context: {
        ...verification.context,
        envelopeType: envelope.envelopeType,
        projectId: envelope.projectId,
        projectEpoch: envelope.projectEpoch,
      },
    });
  } catch {
    return null;
  }
};

export type {
  AccountKeyTransferInput,
  AccountKeyTrustedKeys,
  AccountKeyVerificationContext,
  DeviceKeyMaterial,
  PasswordKdfParameters,
} from "@dotrelay/client";
export {
  createAccountKeyEnvelope,
  createAccountKeyTransfer,
  createAccountKeyWrapper,
  DEFAULT_PASSWORD_KDF,
  encodeRecoveryCode,
  generateAccountMasterKey,
  generateRecoveryCode,
} from "@dotrelay/client";
