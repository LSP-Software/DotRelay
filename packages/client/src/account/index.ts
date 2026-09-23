import {
  ACCOUNT_KEY_ENVELOPE_KDF_INFO,
  ACCOUNT_KEY_WRAPPER_KDF_INFO,
  ARGON2ID_POLICY,
  type CborValue,
  canonicalEncode,
  decodeCiphertextEnvelope,
  deriveAesKeyWithInfo,
  open,
  type ProtocolObject,
  parseProtocolObject,
  protocolObjectFromFields,
  seal,
  sha384,
  signProtocolObject,
} from "@dotrelay/contracts";
import { argon2id } from "@noble/hashes/argon2.js";
import {
  type AccountKeyVerificationContext,
  verifyAccountKeyEnvelope,
  verifyAccountKeyTransfer,
  verifyAccountKeyWrapper,
} from "./verification";

export {
  ACCOUNT_KEY_ENVELOPE_KIND,
  ACCOUNT_KEY_TRANSFER_KIND,
  ACCOUNT_KEY_WRAPPER_FORMAT_VERSION,
  ACCOUNT_KEY_WRAPPER_KIND,
  KDF_ARGON2ID,
  KEY_ENVELOPE_TYPE,
  type KeyEnvelopeType,
  WRAPPER_TYPE,
  type WrapperType,
} from "./constants";
export {
  type AccountKeyTrustedKeys,
  type AccountKeyVerificationContext,
  AccountKeyVerificationError,
  verifyAccountKeyEnvelope,
  verifyAccountKeyTransfer,
  verifyAccountKeyWrapper,
} from "./verification";

import {
  ACCOUNT_KEY_ENVELOPE_KIND,
  ACCOUNT_KEY_TRANSFER_KIND,
  ACCOUNT_KEY_WRAPPER_FORMAT_VERSION,
  ACCOUNT_KEY_WRAPPER_KIND,
  KDF_ARGON2ID,
  KEY_ENVELOPE_TYPE,
  type KeyEnvelopeType,
  PASSKEY_PRF_OUTPUT_LENGTH,
  WRAPPER_TYPE,
  type WrapperType,
} from "./constants";

export type PasswordKdfParameters = Readonly<{
  readonly memoryKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}>;

export const DEFAULT_PASSWORD_KDF: PasswordKdfParameters = Object.freeze({
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
});

export type AccountKeyWrapperInput = Readonly<{
  readonly serverProfileId: string;
  readonly userId: Uint8Array;
  readonly deviceId: Uint8Array;
  readonly userIdentityGeneration: number;
  readonly createdAtMs: number;
  readonly accountMasterKey: Uint8Array;
  readonly signingPrivateKey: CryptoKey;
  readonly wrapperId?: Uint8Array;
  readonly salt?: Uint8Array;
  readonly iv?: Uint8Array;
  readonly kind:
    | Readonly<{
        readonly type: "passkeyPrf";
        readonly credentialId: Uint8Array;
        readonly prfInput: Uint8Array;
        readonly prfOutput: Uint8Array;
      }>
    | Readonly<{
        readonly type: "password";
        readonly password: Uint8Array;
        readonly kdf?: PasswordKdfParameters;
      }>
    | Readonly<{
        readonly type: "recoveryCode";
        readonly recoveryCode: Uint8Array;
      }>;
}>;

export type AccountKeyWrapper = Readonly<{
  readonly object: ProtocolObject;
  readonly wrapperType: WrapperType;
  readonly wrapperId: Uint8Array;
  readonly salt: Uint8Array;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly credentialId?: Uint8Array;
  readonly prfInput?: Uint8Array;
  readonly kdf?: PasswordKdfParameters;
}>;

export type UnwrapAccountKeyWrapperInput = Readonly<{
  readonly password?: Uint8Array;
  readonly prfOutput?: Uint8Array;
  readonly recoveryCode?: Uint8Array;
}>;

export type AccountKeyEnvelopeInput = Readonly<{
  readonly serverProfileId: string;
  readonly userId: Uint8Array;
  readonly deviceId: Uint8Array;
  readonly createdAtMs: number;
  readonly accountMasterKey: Uint8Array;
  readonly signingPrivateKey: CryptoKey;
  readonly salt?: Uint8Array;
  readonly iv?: Uint8Array;
  readonly kind:
    | Readonly<{
        readonly type: "projectEpochKey";
        readonly projectId: Uint8Array;
        readonly projectEpoch: number;
        readonly contentKey: Uint8Array;
      }>
    | Readonly<{
        readonly type: "userValueKey";
        readonly ownerUserId: Uint8Array;
        readonly valueGeneration: number;
        readonly contentKey: Uint8Array;
      }>;
}>;

export type AccountKeyEnvelope = Readonly<{
  readonly object: ProtocolObject;
  readonly envelopeType: KeyEnvelopeType;
  readonly salt: Uint8Array;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly projectId?: Uint8Array;
  readonly projectEpoch?: number;
  readonly ownerUserId?: Uint8Array;
  readonly valueGeneration?: number;
}>;

export type AccountKeyTransferInput = Readonly<{
  readonly serverProfileId: string;
  readonly userId: Uint8Array;
  readonly deviceId: Uint8Array;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly accountMasterKey: Uint8Array;
  readonly recipientDeviceId: string;
  readonly recipientEncryptionPublicKey: CryptoKey;
  readonly signingPrivateKey: CryptoKey;
  readonly transferId?: Uint8Array;
}>;

export type AccountKeyTransfer = Readonly<{
  readonly object: ProtocolObject;
  readonly transferId: Uint8Array;
  readonly recipientDeviceId: Uint8Array;
  readonly expiresAtMs: number;
}>;

const requireLength = (
  value: Uint8Array,
  length: number,
  name: string,
): void => {
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new TypeError(`${name} must be ${length} bytes`);
};

const randomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

const randomId = (): Uint8Array => randomBytes(16);

const uuidToBytes = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized))
    throw new TypeError("server profile id must be a UUID");
  const output = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1)
    output[index] = Number.parseInt(
      normalized.slice(index * 2, index * 2 + 2),
      16,
    );
  return output;
};

const toBuffer = (input: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
};

const SIGNING_FIELDS = new Set([3, 4]);

// Associated data bound into the AES-GCM tag. For a direct-GCM wrapper/envelope
// this is the canonical object body minus the two signing fields and the sealed
// ciphertext/digest pair (fields 47/48), so it binds salt, IV, identity, type
// and KDF parameters without being circular with the ciphertext GCM seals. For
// an X25519 transfer the whole inner envelope (salt/ephemeral/IV/ciphertext/
// digest/lengths) is excluded because that material is sealed by the inner
// seal() rather than a direct GCM call.
const WRAPPER_AAD_EXCLUDED = new Set([3, 4, 47, 48, 72]);
const ENVELOPE_AAD_EXCLUDED = new Set([3, 4, 47, 48, 72]);
const TRANSFER_AAD_EXCLUDED = new Set([3, 4, 44, 45, 46, 47, 48, 71, 72]);

const associatedDataFor = (
  object: ProtocolObject,
  kind: number,
): Uint8Array => {
  const excluded =
    kind === ACCOUNT_KEY_TRANSFER_KIND
      ? TRANSFER_AAD_EXCLUDED
      : kind === ACCOUNT_KEY_ENVELOPE_KIND
        ? ENVELOPE_AAD_EXCLUDED
        : WRAPPER_AAD_EXCLUDED;
  return canonicalEncode(
    new Map([...object.entries()].filter(([field]) => !excluded.has(field))),
  );
};

// Reject password-wrapper KDF cost parameters outside ARGON2ID_POLICY before any
// memory is allocated. Shared by create (pre-argon2id) and unwrap (gate before
// allocation) so a hostile or corrupted wrapper can never drive an unbounded
// Argon2id allocation.
export const validatePasswordKdfParameters = (
  kdf: PasswordKdfParameters,
): void => {
  if (
    !Number.isSafeInteger(kdf.memoryKiB) ||
    kdf.memoryKiB < 8 ||
    kdf.memoryKiB > ARGON2ID_POLICY.maxMemoryKiB ||
    !Number.isSafeInteger(kdf.iterations) ||
    kdf.iterations < 1 ||
    kdf.iterations > ARGON2ID_POLICY.maxIterations ||
    !Number.isSafeInteger(kdf.parallelism) ||
    kdf.parallelism < 1 ||
    kdf.parallelism > ARGON2ID_POLICY.maxParallelism
  )
    throw new TypeError("password KDF parameters are out of policy");
};

// When the host (web app, or the browser bundle test) assigns a self-contained
// worker IIFE source string to this global, the password KDF runs in a Worker
// off the main thread; otherwise runArgon2id uses noble on the main thread.
// Read at call time so the host can set it after module load.
const argon2WorkerSource = (): string | undefined => {
  const value = (globalThis as { __DOTRELAY_ARGON2_WORKER_SOURCE__?: string })
    .__DOTRELAY_ARGON2_WORKER_SOURCE__;
  return typeof value === "string" ? value : undefined;
};

type Argon2WorkerRequest = Readonly<{
  readonly id: number;
  readonly password: Uint8Array;
  readonly salt: Uint8Array;
  readonly params: PasswordKdfParameters;
}>;
type Argon2WorkerReply = Readonly<{
  readonly id: number;
  readonly ikm: Uint8Array;
}>;

let argon2Worker: Worker | null = null;
const pendingArgon2 = new Map<number, (ikm: Uint8Array) => void>();
let argon2RequestId = 0;

const getArgon2Worker = (): Worker | null => {
  const source = argon2WorkerSource();
  if (!source) return null;
  if (argon2Worker === null) {
    const url = URL.createObjectURL(
      new Blob([source], { type: "application/javascript" }),
    );
    argon2Worker = new Worker(url);
    argon2Worker.onmessage = (event: MessageEvent<Argon2WorkerReply>) => {
      const resolve = pendingArgon2.get(event.data.id);
      if (resolve) {
        pendingArgon2.delete(event.data.id);
        resolve(event.data.ikm);
      }
    };
  }
  return argon2Worker;
};

const runArgon2id = async (
  password: Uint8Array,
  salt: Uint8Array,
  kdf: PasswordKdfParameters,
): Promise<Uint8Array> => {
  const worker = getArgon2Worker();
  if (worker) {
    const id = ++argon2RequestId;
    return await new Promise<Uint8Array>((resolve) => {
      pendingArgon2.set(id, resolve);
      worker.postMessage({
        id,
        password,
        salt,
        params: kdf,
      } satisfies Argon2WorkerRequest);
    });
  }
  return argon2id(password, salt, {
    t: kdf.iterations,
    m: kdf.memoryKiB,
    p: kdf.parallelism,
    dkLen: 32,
  });
};

const aesGcmSeal = async (
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Promise<Uint8Array> => {
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toBuffer(iv),
      additionalData: toBuffer(associatedData),
      tagLength: 128,
    },
    key,
    toBuffer(plaintext),
  );
  return new Uint8Array(encrypted);
};

const aesGcmOpen = async (
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
): Promise<Uint8Array> => {
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toBuffer(iv),
        additionalData: toBuffer(associatedData),
        tagLength: 128,
      },
      key,
      toBuffer(ciphertext),
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new Error("account key material decryption failed");
  }
};

const wrapperKek = async (
  ikm: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> =>
  deriveAesKeyWithInfo(ikm, salt, ACCOUNT_KEY_WRAPPER_KDF_INFO);

export const generateAccountMasterKey = (): Uint8Array => randomBytes(32);

export const generateRecoveryCode = (): Uint8Array => randomBytes(32);

export const createAccountKeyWrapper = async (
  input: AccountKeyWrapperInput,
): Promise<AccountKeyWrapper> => {
  requireLength(input.userId, 16, "user id");
  requireLength(input.deviceId, 16, "device id");
  requireLength(input.accountMasterKey, 32, "account master key");
  if (
    !Number.isSafeInteger(input.userIdentityGeneration) ||
    input.userIdentityGeneration < 1
  )
    throw new TypeError("user identity generation must be a positive integer");
  const kind = input.kind;
  const salt = input.salt ?? randomBytes(32);
  requireLength(salt, 32, "wrapper salt");
  const iv = input.iv ?? randomBytes(12);
  requireLength(iv, 12, "wrapper IV");
  const wrapperId = input.wrapperId ?? randomId();
  requireLength(wrapperId, 16, "wrapper id");
  let wrapperType: WrapperType;
  let ikm: Uint8Array;
  let kdf: PasswordKdfParameters | undefined;
  let credentialId: Uint8Array | undefined;
  let prfInput: Uint8Array | undefined;
  if (kind.type === "passkeyPrf") {
    wrapperType = WRAPPER_TYPE.passkeyPrf;
    if (
      !(kind.credentialId instanceof Uint8Array) ||
      kind.credentialId.length === 0 ||
      kind.credentialId.length > 255
    )
      throw new TypeError("passkey credential id must be 1-255 bytes");
    requireLength(kind.prfInput, 32, "passkey PRF input");
    requireLength(
      kind.prfOutput,
      PASSKEY_PRF_OUTPUT_LENGTH,
      "passkey PRF output",
    );
    credentialId = kind.credentialId;
    prfInput = kind.prfInput;
    ikm = kind.prfOutput;
  } else if (kind.type === "password") {
    wrapperType = WRAPPER_TYPE.password;
    kdf = kind.kdf ?? DEFAULT_PASSWORD_KDF;
    validatePasswordKdfParameters(kdf);
    ikm = await runArgon2id(kind.password, salt, kdf);
  } else {
    wrapperType = WRAPPER_TYPE.recoveryCode;
    requireLength(kind.recoveryCode, 32, "recovery code");
    ikm = kind.recoveryCode;
  }
  const keK = await wrapperKek(ikm, salt);
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.serverProfileId)],
    [9, input.userId],
    [10, input.deviceId],
    [17, randomId()],
    [28, input.userIdentityGeneration],
    [32, input.createdAtMs],
    [44, salt],
    [46, iv],
    [71, 32],
    [86, wrapperType],
    [87, wrapperId],
    [88, ACCOUNT_KEY_WRAPPER_FORMAT_VERSION],
  ]);
  if (credentialId) fields.set(93, credentialId);
  if (prfInput) fields.set(94, prfInput);
  if (kdf) {
    fields.set(89, KDF_ARGON2ID);
    fields.set(90, kdf.memoryKiB);
    fields.set(91, kdf.iterations);
    fields.set(92, kdf.parallelism);
  }
  const preSeal = protocolObjectFromFields(ACCOUNT_KEY_WRAPPER_KIND, fields);
  const ciphertext = await aesGcmSeal(
    keK,
    iv,
    input.accountMasterKey,
    associatedDataFor(preSeal, ACCOUNT_KEY_WRAPPER_KIND),
  );
  const ciphertextHash = await sha384(ciphertext);
  fields.set(47, ciphertext);
  fields.set(48, ciphertextHash);
  fields.set(72, ciphertext.length);
  const unsigned = protocolObjectFromFields(ACCOUNT_KEY_WRAPPER_KIND, fields);
  const signedFields = new Map<number, CborValue>([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  const signature = await signProtocolObject(
    protocolObjectFromFields(ACCOUNT_KEY_WRAPPER_KIND, signedFields),
    input.signingPrivateKey,
  );
  signedFields.set(4, signature);
  return Object.freeze({
    object: protocolObjectFromFields(ACCOUNT_KEY_WRAPPER_KIND, signedFields),
    wrapperType,
    wrapperId: new Uint8Array(wrapperId),
    salt: new Uint8Array(salt),
    iv: new Uint8Array(iv),
    ciphertext: new Uint8Array(ciphertext),
    ...(credentialId ? { credentialId: new Uint8Array(credentialId) } : {}),
    ...(prfInput ? { prfInput: new Uint8Array(prfInput) } : {}),
    ...(kdf ? { kdf: { ...kdf } } : {}),
  });
};

const requireField = (
  object: ProtocolObject,
  field: number,
  length?: number,
): Uint8Array => {
  const value = object.get(field);
  if (!(value instanceof Uint8Array))
    throw new TypeError(`field ${field} must be bytes`);
  if (length !== undefined && value.length !== length)
    throw new TypeError(`field ${field} must be ${length} bytes`);
  return value;
};

const decodeProtocolKind = (
  bytes: Uint8Array,
  kind: number,
): ProtocolObject => {
  const object = parseProtocolObject(bytes);
  if (object.get(1) !== kind)
    throw new TypeError(`expected an object of kind ${kind}`);
  return object;
};

const isWrapperType = (value: unknown): value is WrapperType =>
  value === WRAPPER_TYPE.passkeyPrf ||
  value === WRAPPER_TYPE.password ||
  value === WRAPPER_TYPE.recoveryCode;

const isKeyEnvelopeType = (value: unknown): value is KeyEnvelopeType =>
  value === KEY_ENVELOPE_TYPE.projectEpochKey ||
  value === KEY_ENVELOPE_TYPE.userValueKey;

export const parseAccountKeyWrapper = (
  bytes: Uint8Array,
): AccountKeyWrapper => {
  const object = decodeProtocolKind(bytes, ACCOUNT_KEY_WRAPPER_KIND);
  const wrapperType = object.get(86);
  if (!isWrapperType(wrapperType)) throw new TypeError("unknown wrapper type");
  const credentialId = object.get(93);
  const prfInput = object.get(94);
  const kdfMemory = object.get(90);
  const kdfIterations = object.get(91);
  const kdfParallelism = object.get(92);
  return Object.freeze({
    object,
    wrapperType,
    wrapperId: requireField(object, 87, 16),
    salt: requireField(object, 44, 32),
    iv: requireField(object, 46, 12),
    ciphertext: requireField(object, 47),
    ...(credentialId instanceof Uint8Array
      ? { credentialId: new Uint8Array(credentialId) }
      : {}),
    ...(prfInput instanceof Uint8Array
      ? { prfInput: new Uint8Array(prfInput) }
      : {}),
    ...(kdfMemory !== undefined &&
    kdfIterations !== undefined &&
    kdfParallelism !== undefined &&
    typeof kdfMemory === "number" &&
    typeof kdfIterations === "number" &&
    typeof kdfParallelism === "number"
      ? {
          kdf: Object.freeze({
            memoryKiB: kdfMemory,
            iterations: kdfIterations,
            parallelism: kdfParallelism,
          }),
        }
      : {}),
  });
};

export const unwrapAccountKeyWrapper = async (
  wrapper: AccountKeyWrapper,
  input: UnwrapAccountKeyWrapperInput,
  verification: Readonly<{
    readonly trustedKeys: import("./verification").AccountKeyTrustedKeys;
    readonly context: AccountKeyVerificationContext;
  }>,
): Promise<Uint8Array> => {
  await verifyAccountKeyWrapper(
    wrapper.object,
    verification.trustedKeys,
    verification.context,
  );
  let ikm: Uint8Array;
  if (wrapper.wrapperType === WRAPPER_TYPE.passkeyPrf) {
    if (!input.prfOutput) throw new TypeError("passkey PRF output is required");
    requireLength(
      input.prfOutput,
      PASSKEY_PRF_OUTPUT_LENGTH,
      "passkey PRF output",
    );
    ikm = input.prfOutput;
  } else if (wrapper.wrapperType === WRAPPER_TYPE.password) {
    if (!input.password) throw new TypeError("password is required");
    const kdf = wrapper.kdf;
    if (!kdf) throw new TypeError("password KDF parameters are missing");
    validatePasswordKdfParameters(kdf);
    ikm = await runArgon2id(input.password, wrapper.salt, kdf);
  } else {
    if (!input.recoveryCode) throw new TypeError("recovery code is required");
    requireLength(input.recoveryCode, 32, "recovery code");
    ikm = input.recoveryCode;
  }
  const keK = await wrapperKek(ikm, wrapper.salt);
  const accountMasterKey = await aesGcmOpen(
    keK,
    wrapper.iv,
    wrapper.ciphertext,
    associatedDataFor(wrapper.object, ACCOUNT_KEY_WRAPPER_KIND),
  );
  requireLength(accountMasterKey, 32, "account master key");
  return accountMasterKey;
};

export const createAccountKeyEnvelope = async (
  input: AccountKeyEnvelopeInput,
): Promise<AccountKeyEnvelope> => {
  requireLength(input.userId, 16, "user id");
  requireLength(input.deviceId, 16, "device id");
  requireLength(input.accountMasterKey, 32, "account master key");
  const kind = input.kind;
  let envelopeType: KeyEnvelopeType;
  if (kind.type === "projectEpochKey") {
    envelopeType = KEY_ENVELOPE_TYPE.projectEpochKey;
    requireLength(kind.projectId, 16, "project id");
    if (!Number.isSafeInteger(kind.projectEpoch) || kind.projectEpoch < 1)
      throw new TypeError("project epoch must be a positive integer");
  } else {
    envelopeType = KEY_ENVELOPE_TYPE.userValueKey;
    requireLength(kind.ownerUserId, 16, "owner user id");
    if (!Number.isSafeInteger(kind.valueGeneration) || kind.valueGeneration < 1)
      throw new TypeError("value generation must be a positive integer");
  }
  requireLength(kind.contentKey, 32, "content key");
  const salt = input.salt ?? randomBytes(32);
  const iv = input.iv ?? randomBytes(12);
  const keK = await deriveAesKeyWithInfo(
    input.accountMasterKey,
    salt,
    ACCOUNT_KEY_ENVELOPE_KDF_INFO,
  );
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.serverProfileId)],
    [9, input.userId],
    [10, input.deviceId],
    [17, randomId()],
    [32, input.createdAtMs],
    [44, salt],
    [46, iv],
    [71, 32],
    [88, ACCOUNT_KEY_WRAPPER_FORMAT_VERSION],
    [96, envelopeType],
  ]);
  if (kind.type === "projectEpochKey") {
    fields.set(13, kind.projectId);
    fields.set(30, kind.projectEpoch);
  } else {
    fields.set(26, kind.ownerUserId);
    fields.set(31, kind.valueGeneration);
  }
  const preSeal = protocolObjectFromFields(ACCOUNT_KEY_ENVELOPE_KIND, fields);
  const ciphertext = await aesGcmSeal(
    keK,
    iv,
    kind.contentKey,
    associatedDataFor(preSeal, ACCOUNT_KEY_ENVELOPE_KIND),
  );
  const ciphertextHash = await sha384(ciphertext);
  fields.set(47, ciphertext);
  fields.set(48, ciphertextHash);
  fields.set(72, ciphertext.length);
  const unsigned = protocolObjectFromFields(ACCOUNT_KEY_ENVELOPE_KIND, fields);
  const signedFields = new Map<number, CborValue>([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  const signature = await signProtocolObject(
    protocolObjectFromFields(ACCOUNT_KEY_ENVELOPE_KIND, signedFields),
    input.signingPrivateKey,
  );
  signedFields.set(4, signature);
  return Object.freeze({
    object: protocolObjectFromFields(ACCOUNT_KEY_ENVELOPE_KIND, signedFields),
    envelopeType,
    salt: new Uint8Array(salt),
    iv: new Uint8Array(iv),
    ciphertext: new Uint8Array(ciphertext),
    ...(kind.type === "projectEpochKey"
      ? {
          projectId: new Uint8Array(kind.projectId),
          projectEpoch: kind.projectEpoch,
        }
      : {
          ownerUserId: new Uint8Array(kind.ownerUserId),
          valueGeneration: kind.valueGeneration,
        }),
  });
};

export const parseAccountKeyEnvelope = (
  bytes: Uint8Array,
): AccountKeyEnvelope => {
  const object = decodeProtocolKind(bytes, ACCOUNT_KEY_ENVELOPE_KIND);
  const envelopeType = object.get(96);
  if (!isKeyEnvelopeType(envelopeType))
    throw new TypeError("unknown key envelope type");
  const projectId = object.get(13);
  const projectEpoch = object.get(30);
  const ownerUserId = object.get(26);
  const valueGeneration = object.get(31);
  return Object.freeze({
    object,
    envelopeType,
    salt: requireField(object, 44, 32),
    iv: requireField(object, 46, 12),
    ciphertext: requireField(object, 47),
    ...(projectId instanceof Uint8Array && typeof projectEpoch === "number"
      ? { projectId: new Uint8Array(projectId), projectEpoch }
      : {}),
    ...(ownerUserId instanceof Uint8Array && typeof valueGeneration === "number"
      ? { ownerUserId: new Uint8Array(ownerUserId), valueGeneration }
      : {}),
  });
};

export const openAccountKeyEnvelope = async (
  envelope: AccountKeyEnvelope,
  accountMasterKey: Uint8Array,
  verification: Readonly<{
    readonly trustedKeys: import("./verification").AccountKeyTrustedKeys;
    readonly context: AccountKeyVerificationContext & {
      readonly envelopeType: number;
      readonly projectId?: Uint8Array;
      readonly projectEpoch?: number;
      readonly ownerUserId?: Uint8Array;
      readonly valueGeneration?: number;
    };
  }>,
): Promise<Uint8Array> => {
  await verifyAccountKeyEnvelope(
    envelope.object,
    verification.trustedKeys,
    verification.context,
  );
  requireLength(accountMasterKey, 32, "account master key");
  const keK = await deriveAesKeyWithInfo(
    accountMasterKey,
    envelope.salt,
    ACCOUNT_KEY_ENVELOPE_KDF_INFO,
  );
  const contentKey = await aesGcmOpen(
    keK,
    envelope.iv,
    envelope.ciphertext,
    associatedDataFor(envelope.object, ACCOUNT_KEY_ENVELOPE_KIND),
  );
  requireLength(contentKey, 32, "content key");
  return contentKey;
};

export const createAccountKeyTransfer = async (
  input: AccountKeyTransferInput,
): Promise<AccountKeyTransfer> => {
  requireLength(input.userId, 16, "user id");
  requireLength(input.deviceId, 16, "device id");
  requireLength(input.accountMasterKey, 32, "account master key");
  if (
    !Number.isSafeInteger(input.createdAtMs) ||
    !Number.isSafeInteger(input.expiresAtMs) ||
    input.expiresAtMs <= input.createdAtMs
  )
    throw new TypeError("transfer validity window is invalid");
  const transferId = input.transferId ?? randomId();
  requireLength(transferId, 16, "transfer id");
  // The inner X25519 envelope's associated data binds the outer object's
  // identity/expiry/type fields. Those fields are final before sealing, so the
  // AAD is computable up front; the sealed envelope material (salt/ephemeral/
  // IV/ciphertext/digest/lengths) is excluded from the AAD and re-read from the
  // sealed bytes below.
  const preSeal = protocolObjectFromFields(
    ACCOUNT_KEY_TRANSFER_KIND,
    new Map<number, CborValue>([
      [8, uuidToBytes(input.serverProfileId)],
      [9, input.userId],
      [10, input.deviceId],
      [17, randomId()],
      [25, uuidToBytes(input.recipientDeviceId)],
      [32, input.createdAtMs],
      [33, input.expiresAtMs],
      [88, ACCOUNT_KEY_WRAPPER_FORMAT_VERSION],
      [95, transferId],
    ]),
  );
  const aad = associatedDataFor(preSeal, ACCOUNT_KEY_TRANSFER_KIND);
  const envelopeBytes = await seal(
    input.accountMasterKey,
    input.recipientEncryptionPublicKey,
    aad,
  );
  const envelope = decodeCiphertextEnvelope(envelopeBytes);
  const salt = envelope.get(44);
  const ephemeralPublicKey = envelope.get(45);
  const iv = envelope.get(46);
  const ciphertext = envelope.get(47);
  const ciphertextHash = envelope.get(48);
  const plaintextLength = envelope.get(71);
  const ciphertextLength = envelope.get(72);
  if (
    !(salt instanceof Uint8Array) ||
    !(ephemeralPublicKey instanceof Uint8Array) ||
    !(iv instanceof Uint8Array) ||
    !(ciphertext instanceof Uint8Array) ||
    !(ciphertextHash instanceof Uint8Array) ||
    typeof plaintextLength !== "number" ||
    typeof ciphertextLength !== "number"
  )
    throw new Error("account key transfer envelope is malformed");
  const fields = new Map<number, CborValue>([
    [8, uuidToBytes(input.serverProfileId)],
    [9, input.userId],
    [10, input.deviceId],
    [17, preSeal.get(17) as CborValue],
    [25, uuidToBytes(input.recipientDeviceId)],
    [32, input.createdAtMs],
    [33, input.expiresAtMs],
    [44, salt],
    [45, ephemeralPublicKey],
    [46, iv],
    [47, ciphertext],
    [48, ciphertextHash],
    [71, plaintextLength],
    [72, ciphertextLength],
    [88, ACCOUNT_KEY_WRAPPER_FORMAT_VERSION],
    [95, transferId],
  ]);
  const unsigned = protocolObjectFromFields(ACCOUNT_KEY_TRANSFER_KIND, fields);
  const signedFields = new Map<number, CborValue>([
    ...fields,
    [3, canonicalEncode(unsigned)],
    [4, new Uint8Array(64)],
  ]);
  const signature = await signProtocolObject(
    protocolObjectFromFields(ACCOUNT_KEY_TRANSFER_KIND, signedFields),
    input.signingPrivateKey,
  );
  signedFields.set(4, signature);
  return Object.freeze({
    object: protocolObjectFromFields(ACCOUNT_KEY_TRANSFER_KIND, signedFields),
    transferId: new Uint8Array(transferId),
    recipientDeviceId: uuidToBytes(input.recipientDeviceId),
    expiresAtMs: input.expiresAtMs,
  });
};

export const parseAccountKeyTransfer = (
  bytes: Uint8Array,
): AccountKeyTransfer => {
  const object = decodeProtocolKind(bytes, ACCOUNT_KEY_TRANSFER_KIND);
  const expiresAtMs = object.get(33);
  if (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs))
    throw new TypeError("transfer expiry is invalid");
  return Object.freeze({
    object,
    transferId: requireField(object, 95, 16),
    recipientDeviceId: requireField(object, 25, 16),
    expiresAtMs,
  });
};

export const openAccountKeyTransfer = async (
  transfer: AccountKeyTransfer,
  recipientX25519PrivateKey: CryptoKey,
  verification: Readonly<{
    readonly trustedKeys: import("./verification").AccountKeyTrustedKeys;
    readonly context: AccountKeyVerificationContext & {
      readonly ownDeviceId: Uint8Array;
      readonly nowMs: number;
    };
  }>,
): Promise<Uint8Array> => {
  await verifyAccountKeyTransfer(
    transfer.object,
    verification.trustedKeys,
    verification.context,
  );
  const object = transfer.object;
  const requiredField = (key: number): CborValue => {
    const value = object.get(key);
    if (value === undefined)
      throw new TypeError(`transfer is missing field ${key}`);
    return value;
  };
  const envelope = canonicalEncode(
    new Map<number, CborValue>([
      [0, requiredField(0)],
      [44, requiredField(44)],
      [45, requiredField(45)],
      [46, requiredField(46)],
      [47, requiredField(47)],
      [48, requiredField(48)],
      [71, requiredField(71)],
      [72, requiredField(72)],
    ]),
  );
  const accountMasterKey = await open(
    envelope,
    recipientX25519PrivateKey,
    associatedDataFor(object, ACCOUNT_KEY_TRANSFER_KIND),
  );
  requireLength(accountMasterKey, 32, "account master key");
  return accountMasterKey;
};

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_LOOKUP = new Map<string, number>();
for (let index = 0; index < CROCKFORD_ALPHABET.length; index += 1) {
  const symbol = CROCKFORD_ALPHABET[index];
  if (symbol !== undefined) CROCKFORD_LOOKUP.set(symbol, index);
}

export const encodeRecoveryCode = (code: Uint8Array): string => {
  requireLength(code, 32, "recovery code");
  const symbols: string[] = [];
  for (let symbol = 0; symbol < 52; symbol += 1) {
    let value = 0;
    for (let bit = 0; bit < 5; bit += 1) {
      const position = symbol * 5 + bit;
      if (position < 256) {
        const byte = code[position >> 3] ?? 0;
        value = (value << 1) | ((byte >> (7 - (position & 7))) & 1);
      } else {
        value <<= 1;
      }
    }
    const symbolCharacter = CROCKFORD_ALPHABET[value];
    if (symbolCharacter === undefined)
      throw new Error("recovery code encoding failed");
    symbols.push(symbolCharacter);
  }
  const groups: string[] = [];
  for (let index = 0; index < symbols.length; index += 4)
    groups.push(symbols.slice(index, index + 4).join(""));
  return groups.join("-");
};

export const decodeRecoveryCode = (text: string): Uint8Array => {
  const normalized = text.toUpperCase().replaceAll("-", "").trim();
  if (!/^[0-9A-HJKMNP-TV-Z]{52}$/.test(normalized))
    throw new TypeError("recovery code is malformed");
  const bytes = new Uint8Array(32);
  for (let symbol = 0; symbol < 52; symbol += 1) {
    const character = normalized[symbol];
    if (character === undefined)
      throw new TypeError("recovery code is malformed");
    const value = CROCKFORD_LOOKUP.get(character);
    if (value === undefined) throw new TypeError("recovery code is malformed");
    if (symbol === 51 && value & 0b0000_1111)
      throw new TypeError("recovery code is malformed");
    for (let bit = 4; bit >= 0; bit -= 1) {
      const position = symbol * 5 + (4 - bit);
      if (position >= 256) break;
      if (value & (1 << bit)) {
        const byteIndex = position >> 3;
        const current = bytes[byteIndex] ?? 0;
        bytes[byteIndex] = current | (1 << (7 - (position & 7)));
      }
    }
  }
  return bytes;
};
