import {
  chmod,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createAccountKeyTransfer,
  createAccountKeyWrapper,
  decodeRecoveryCode,
  encodeRecoveryCode,
  exportSigningPublicKey,
  generateAccountMasterKey,
  generateRecoveryCode,
  openAccountKeyTransfer,
  parseAccountKeyTransfer,
  parseAccountKeyWrapper,
  unwrapAccountKeyWrapper,
} from "@dotrelay/client";
import {
  encodeProtocolObject,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";
import type { StrictJsonClient } from "./admin";
import { CliError, CliInvocationError } from "./errors";
import { readTerminalSecret } from "./ui";
import {
  accountKeyTrustedKeys,
  base64,
  bytesToHex,
  fromBase64,
  hexToBytes,
  isRecord,
  loadAuthorizedDevice,
  resolveDeviceStorage,
  type WorkflowOptions,
} from "./workflow-core";
import { enrollFirstDevice } from "./workflow-device-enrollment";
export const accountKeyScope = (options: WorkflowOptions, deviceId: string) =>
  Object.freeze({ pin: options.profile.pin, deviceId: uuidToBytes(deviceId) });

export const loadAccountMasterKey = async (
  options: WorkflowOptions,
  deviceId: string,
): Promise<Uint8Array | null> => {
  const storage = resolveDeviceStorage(options);
  try {
    return await storage.loadAccountKey(accountKeyScope(options, deviceId));
  } catch {
    return null;
  }
};

export type ActiveWrapper = Readonly<{
  readonly wrapperId: string;
  readonly type: "passkey-prf" | "password" | "recovery-code";
  readonly object: string;
  readonly creatorDeviceId?: string;
  readonly creatorPublicKey?: string;
}>;

export const isActiveWrapper = (value: unknown): value is ActiveWrapper => {
  if (!isRecord(value)) return false;
  const wrapperId = value.wrapperId;
  const object = value.object;
  return (
    typeof wrapperId === "string" &&
    wrapperId.length > 0 &&
    (value.type === "passkey-prf" ||
      value.type === "password" ||
      value.type === "recovery-code") &&
    typeof object === "string" &&
    object.length > 0 &&
    (value.creatorDeviceId === undefined ||
      typeof value.creatorDeviceId === "string") &&
    (value.creatorPublicKey === undefined ||
      typeof value.creatorPublicKey === "string")
  );
};

export const fetchActiveWrappers = async (
  admin: StrictJsonClient,
): Promise<readonly ActiveWrapper[]> => {
  const body = await admin.get("/api/v1/account-keys/wrappers", ["wrappers"]);
  const wrappers = body.wrappers;
  if (!Array.isArray(wrappers))
    throw new CliError(
      "transient",
      "the Server Profile returned an invalid wrapper list",
      {},
      "response_invalid",
    );
  return Object.freeze(wrappers.filter(isActiveWrapper));
};

type PendingRecoveryCode = {
  readonly purpose: "setup" | "rotation";
  readonly recoveryCode: string;
  readonly wrapperId: string;
  readonly operationId: string;
  readonly objectId: string;
  readonly object: string;
  readonly identityGeneration: string;
  readonly ciphertextHash: string;
  readonly ciphertextLength: number;
};

const pendingRecoveryPath = (
  options: WorkflowOptions,
  deviceId: string,
): string =>
  join(options.stateDirectory, `recovery-code-pending-${deviceId}.json`);

// Set only after the wrapper publish has succeeded, so the process can
// delete the local copy once it has written the code to stdout. A failure
// leaves this unset and the file in place for the retry.
let displayedRecoveryCodePath: string | null = null;

const markRecoveryCodeReadyToDisplay = (
  options: WorkflowOptions,
  deviceId: string,
): void => {
  displayedRecoveryCodePath = pendingRecoveryPath(options, deviceId);
};

export const consumeDisplayedRecoveryCodePath = (): string | null => {
  const path = displayedRecoveryCodePath;
  displayedRecoveryCodePath = null;
  return path;
};

const readPendingRecoveryCode = async (
  options: WorkflowOptions,
  deviceId: string,
): Promise<PendingRecoveryCode | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(pendingRecoveryPath(options, deviceId), "utf8"),
    ) as Partial<PendingRecoveryCode>;
    if (
      (parsed.purpose !== "setup" && parsed.purpose !== "rotation") ||
      typeof parsed.recoveryCode !== "string" ||
      typeof parsed.wrapperId !== "string" ||
      typeof parsed.operationId !== "string" ||
      typeof parsed.objectId !== "string" ||
      typeof parsed.object !== "string" ||
      typeof parsed.identityGeneration !== "string" ||
      typeof parsed.ciphertextHash !== "string" ||
      typeof parsed.ciphertextLength !== "number"
    )
      return null;
    return parsed as PendingRecoveryCode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const writePendingRecoveryCode = async (
  options: WorkflowOptions,
  deviceId: string,
  pending: PendingRecoveryCode,
): Promise<void> => {
  const path = pendingRecoveryPath(options, deviceId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(pending), { mode: 0o600 });
  await chmod(path, 0o600);
};

export const clearPresentedRecoveryCode = async (
  options: WorkflowOptions,
  deviceId: string,
): Promise<void> => {
  await unlink(pendingRecoveryPath(options, deviceId)).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    },
  );
};

const publishRecoveryWrapper = async (
  admin: StrictJsonClient,
  pending: PendingRecoveryCode,
): Promise<void> => {
  await admin.post(
    "/api/v1/account-keys/wrappers",
    {
      operationId: pending.operationId,
      objectId: pending.objectId,
      object: pending.object,
      wrapperId: pending.wrapperId,
      identityGeneration: pending.identityGeneration,
      ciphertextHash: pending.ciphertextHash,
      ciphertextLength: pending.ciphertextLength,
    },
    ["wrapperId", "idempotent"],
    { idempotencyKey: pending.operationId },
  );
};

const pendingFromWrapper = async (
  purpose: "setup" | "rotation",
  recoveryCode: Uint8Array,
  wrapper: Awaited<ReturnType<typeof createAccountKeyWrapper>>,
  identityGeneration: number,
): Promise<PendingRecoveryCode> =>
  Object.freeze({
    purpose,
    recoveryCode: encodeRecoveryCode(recoveryCode),
    wrapperId: bytesToHex(wrapper.wrapperId),
    operationId: crypto.randomUUID(),
    objectId: crypto.randomUUID(),
    object: base64(encodeProtocolObject(wrapper.object)),
    identityGeneration: String(identityGeneration),
    ciphertextHash: sha384ToHex(await sha384(wrapper.ciphertext)),
    ciphertextLength: wrapper.ciphertext.length,
  });

export const createRecoveryCodeBackup = async (
  options: WorkflowOptions,
): Promise<
  Readonly<{
    readonly recoveryCode: string;
    readonly wrapperId: string;
    readonly message: string;
  }>
> => {
  const authorized = await loadAuthorizedDevice(options);
  const storage = resolveDeviceStorage(options);
  const accountMasterKey = await storage
    .loadAccountKey(accountKeyScope(options, authorized.deviceId))
    .catch(() => null);
  if (!accountMasterKey)
    throw new CliError(
      "authentication",
      "this Device is not unlocked; run dotrelay device recover to unlock it",
      {},
      "account_key_not_unlocked",
    );
  const wrappers = await fetchActiveWrappers(authorized.admin);
  const pending = await readPendingRecoveryCode(options, authorized.deviceId);
  if (pending?.purpose === "setup")
    throw new CliError(
      "conflict",
      "device setup has a recovery code waiting to be published; rerun dotrelay device setup before replacing it",
      {},
      "account_key_setup_pending",
    );
  if (pending?.purpose === "rotation") {
    if (!wrappers.some((wrapper) => wrapper.wrapperId === pending.wrapperId)) {
      try {
        await publishRecoveryWrapper(authorized.admin, pending);
      } catch {
        throw new CliError(
          "transient",
          "the replacement was not published, so the previous recovery code still works. Rerun dotrelay device backup to retry the same replacement.",
          {},
          "recovery_code_not_published",
        );
      }
    }
    markRecoveryCodeReadyToDisplay(options, authorized.deviceId);
    return {
      recoveryCode: pending.recoveryCode,
      wrapperId: pending.wrapperId,
      message:
        "A new Recovery Code wrapper is active and the previous recovery code no longer works; the code is shown only once, so store it somewhere safe",
    };
  }
  const recoveryCode = generateRecoveryCode();
  const wrapper = await createAccountKeyWrapper({
    serverProfileId: options.profile.pin.serverProfileId,
    userId: uuidToBytes(authorized.userId),
    deviceId: uuidToBytes(authorized.deviceId),
    userIdentityGeneration: authorized.bundle.userIdentityGeneration,
    createdAtMs: Date.now(),
    accountMasterKey,
    signingPrivateKey: authorized.keys.signingPrivateKey,
    kind: { type: "recoveryCode", recoveryCode },
  });
  const next = await pendingFromWrapper(
    "rotation",
    recoveryCode,
    wrapper,
    authorized.bundle.userIdentityGeneration,
  );
  await writePendingRecoveryCode(options, authorized.deviceId, next);
  try {
    await publishRecoveryWrapper(authorized.admin, next);
  } catch {
    throw new CliError(
      "transient",
      "the replacement was not published, so the previous recovery code still works. Rerun dotrelay device backup to retry the same replacement.",
      {},
      "recovery_code_not_published",
    );
  }
  markRecoveryCodeReadyToDisplay(options, authorized.deviceId);
  return {
    recoveryCode: next.recoveryCode,
    wrapperId: next.wrapperId,
    message:
      "A new Recovery Code wrapper is active and the previous recovery code no longer works; the code is shown only once, so store it somewhere safe",
  };
};

// The Recovery Code is a secret: it never appears in the process argument
// list. The automation channel is a 0600 file (--recovery-code-file <path>);
// otherwise an interactive terminal reads it at a masked prompt, and a
// non-TTY caller may pipe the single code line on stdin (with a printed
// warning). The code never leaves the machine and is never sent to the
// Server Profile.
export const readRecoveryCode = async (
  options: WorkflowOptions,
  path: string | undefined,
): Promise<string> => {
  if (path !== undefined) {
    let file = "";
    try {
      const info = await stat(path);
      // A symlink or non-regular file never qualifies as a 0600 secret.
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("not a regular file");
      if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)
        throw new Error("wrong mode");
      file = await readFile(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT")
        throw new CliError(
          "local-io",
          `the recovery code file does not exist: ${path}`,
          {},
          "recovery_code_file_missing",
        );
      if (code === "EACCES")
        throw new CliError(
          "local-io",
          `the recovery code file is not readable: ${path}`,
          {},
          "recovery_code_file_invalid",
        );
      throw new CliError(
        "local-io",
        `--recovery-code-file must point to a regular, non-symlink file with mode 0600: ${path}`,
        {},
        "recovery_code_file_invalid",
      );
    }
    return file.trim();
  }
  if (options.noInput)
    throw new CliError(
      "invocation",
      "--no-input reads no secret; pass --recovery-code-file <path> or pipe the code on stdin",
      {},
      "recovery_code_required",
    );
  return await readTerminalSecret("Recovery Code", {
    ...(options.terminal ? { terminal: options.terminal } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
  });
};

export const recoverAccountKey = async (
  options: WorkflowOptions,
  input: Readonly<{
    readonly recoveryCodeFile?: string;
    readonly transferId?: string;
  }>,
): Promise<
  Readonly<{
    readonly deviceId: string;
    readonly via: "recovery-code" | "transfer";
    readonly message: string;
  }>
> => {
  const hasCodeFile = input.recoveryCodeFile !== undefined;
  const hasTransfer = input.transferId !== undefined;
  if (hasCodeFile && hasTransfer)
    throw new CliInvocationError(
      "device recover accepts either --recovery-code-file <path> or --transfer <transfer-id>, not both",
    );
  await enrollFirstDevice(options);
  const authorized = await loadAuthorizedDevice(options);
  const storage = resolveDeviceStorage(options);
  let accountMasterKey: Uint8Array;
  let via: "recovery-code" | "transfer";
  if (!hasTransfer) {
    const codeText = await readRecoveryCode(options, input.recoveryCodeFile);
    let code: Uint8Array;
    try {
      code = decodeRecoveryCode(codeText);
    } catch {
      throw new CliError(
        "invocation",
        "the recovery code is malformed; it is 13 groups of 4 Crockford characters",
        {},
        "recovery_code_malformed",
      );
    }
    const wrappers = await fetchActiveWrappers(authorized.admin);
    const entry = wrappers.find((wrapper) => wrapper.type === "recovery-code");
    if (!entry)
      throw new CliError(
        "conflict",
        "the account has no active Recovery Code wrapper; create one with dotrelay device backup or the web app",
        {},
        "recovery_wrapper_missing",
      );
    let wrapper: ReturnType<typeof parseAccountKeyWrapper>;
    try {
      wrapper = parseAccountKeyWrapper(
        fromBase64(entry.object, "recovery wrapper"),
      );
    } catch {
      throw new CliError(
        "transient",
        "the Server Profile returned an invalid recovery wrapper",
        {},
        "response_invalid",
      );
    }
    try {
      const localSigningKey = await exportSigningPublicKey(
        authorized.keys.signingPublicKey as CryptoKey,
      );
      // The wrapper is sealed and signed by the Device that created it, which
      // may be a different Device than the one opening it with the code. The
      // creator's identity fields (deviceId/userIdentityGeneration) are
      // signature-authenticated, so pin only the shared profile/user identity
      // and add the creator's key to the trust set when the API reports it.
      accountMasterKey = await unwrapAccountKeyWrapper(
        wrapper,
        { recoveryCode: code },
        {
          trustedKeys: accountKeyTrustedKeys(
            authorized.boundary,
            localSigningKey,
            entry.creatorPublicKey ? [entry.creatorPublicKey] : [],
          ),
          context: {
            serverProfileId: uuidToBytes(options.profile.pin.serverProfileId),
            userId: uuidToBytes(authorized.userId),
          },
        },
      );
    } catch {
      throw new CliError(
        "authentication",
        "could not unlock the account with the recovery code; re-check the code and retry",
        {},
        "account_key_unlock_failed",
      );
    }
    via = "recovery-code";
  } else {
    const transferId = (input.transferId as string).toLowerCase();
    let result: Record<string, unknown>;
    try {
      result = await authorized.admin.post(
        `/api/v1/account-keys/transfers/${transferId}/accept`,
        {},
        ["accepted", "object", "creatorDeviceId", "creatorPublicKey"],
      );
    } catch (error) {
      if (error instanceof CliError && error.code === "state_conflict")
        throw new CliError(
          "conflict",
          "the account key transfer is not pending or has expired; have the approving Device create a new transfer",
          {},
          "state_conflict",
        );
      throw error;
    }
    const creatorPublicKey =
      typeof result.creatorPublicKey === "string"
        ? [result.creatorPublicKey]
        : [];
    let transfer: ReturnType<typeof parseAccountKeyTransfer>;
    try {
      transfer = parseAccountKeyTransfer(
        fromBase64(result.object, "transfer object"),
      );
    } catch {
      throw new CliError(
        "transient",
        "the Server Profile returned an invalid account key transfer",
        {},
        "response_invalid",
      );
    }
    try {
      const localSigningKey = await exportSigningPublicKey(
        authorized.keys.signingPublicKey as CryptoKey,
      );
      accountMasterKey = await openAccountKeyTransfer(
        transfer,
        authorized.keys.encryptionPrivateKey,
        {
          trustedKeys: accountKeyTrustedKeys(
            authorized.boundary,
            localSigningKey,
            creatorPublicKey,
          ),
          context: {
            serverProfileId: uuidToBytes(options.profile.pin.serverProfileId),
            userId: uuidToBytes(authorized.userId),
            // The transfer's deviceId/userIdentityGeneration are the sender's
            // (signature-authenticated); the recipient pins only the binding to
            // itself (field 25) and the expiry window.
            ownDeviceId: uuidToBytes(authorized.deviceId),
            nowMs: Date.now(),
          },
        },
      );
    } catch {
      throw new CliError(
        "crypto",
        "could not open the account key transfer for this Device",
        {},
        "account_key_transfer_invalid",
      );
    }
    via = "transfer";
  }
  await storage.saveAccountKey(
    accountKeyScope(options, authorized.deviceId),
    accountMasterKey,
  );
  return {
    deviceId: authorized.deviceId,
    via,
    message:
      via === "recovery-code"
        ? "unlocked with the recovery code; the Account Master Key is now stored on this Device"
        : "unlocked by the trusted Device transfer; the Account Master Key is now stored on this Device",
  };
};

// Account Master Key establishment, handoff, and recovery-wrapper lifecycle
// are driven from the CLI for headless Devices. The browser keeps the AMK
// in-memory only, so a CLI Device is the surface that persists it; these
// commands cover the same lifecycle a browser session would, through the
// production /api/v1/account-keys/* routes.

// A transfer is sealed for a single peer Device and consumed exactly once;
// a short validity window keeps an unaccepted transfer from lingering while
// staying far below the service's staging TTL.
export const accountKeyTransferValidityMs = 5 * 60 * 1000;

export const setupDeviceAccountKey = async (
  options: WorkflowOptions,
): Promise<
  Readonly<{
    readonly deviceId: string;
    readonly recoveryCode?: string;
    readonly wrapperId?: string;
    readonly message: string;
  }>
> => {
  await enrollFirstDevice(options);
  const authorized = await loadAuthorizedDevice(options);
  const storage = resolveDeviceStorage(options);
  const scope = accountKeyScope(options, authorized.deviceId);
  const existing = await loadAccountMasterKey(options, authorized.deviceId);
  const wrappers = await fetchActiveWrappers(authorized.admin);
  const pending = await readPendingRecoveryCode(options, authorized.deviceId);
  if (pending?.purpose === "setup") {
    if (!existing)
      throw new CliError(
        "local-io",
        "a recovery code is waiting on this device, but its Account Master Key is not saved. The account is not recoverable from this device.",
        {},
        "account_key_not_saved",
      );
    if (!wrappers.some((wrapper) => wrapper.wrapperId === pending.wrapperId)) {
      try {
        await publishRecoveryWrapper(authorized.admin, pending);
      } catch {
        throw new CliError(
          "transient",
          "the recovery code is saved on this device, but the server does not have it yet. Rerun dotrelay device setup to retry the same key. The account is not recoverable from another device until that succeeds.",
          {},
          "recovery_code_not_published",
        );
      }
    }
    markRecoveryCodeReadyToDisplay(options, authorized.deviceId);
    return {
      deviceId: authorized.deviceId,
      recoveryCode: pending.recoveryCode,
      wrapperId: pending.wrapperId,
      message:
        "the Account Master Key is set up on this Device; the Recovery Code is shown only once, so store it somewhere safe",
    };
  }
  if (!existing && wrappers.length > 0)
    throw new CliError(
      "conflict",
      "this account already has an Account Master Key; run dotrelay device recover to take it over from an existing Device",
      {},
      "account_key_already_exists",
    );
  if (existing && wrappers.some((wrapper) => wrapper.type === "recovery-code"))
    return {
      deviceId: authorized.deviceId,
      message:
        "this Device already holds the Account Master Key; nothing to set up",
    };
  const accountMasterKey = existing ?? generateAccountMasterKey();
  const recoveryCode = generateRecoveryCode();
  const wrapper = await createAccountKeyWrapper({
    serverProfileId: options.profile.pin.serverProfileId,
    userId: uuidToBytes(authorized.userId),
    deviceId: uuidToBytes(authorized.deviceId),
    userIdentityGeneration: authorized.bundle.userIdentityGeneration,
    createdAtMs: Date.now(),
    accountMasterKey,
    signingPrivateKey: authorized.keys.signingPrivateKey,
    kind: { type: "recoveryCode", recoveryCode },
  });
  if (!existing) await storage.saveAccountKey(scope, accountMasterKey);
  const next = await pendingFromWrapper(
    "setup",
    recoveryCode,
    wrapper,
    authorized.bundle.userIdentityGeneration,
  );
  await writePendingRecoveryCode(options, authorized.deviceId, next);
  try {
    await publishRecoveryWrapper(authorized.admin, next);
  } catch {
    throw new CliError(
      "transient",
      "the recovery code is saved on this device, but the server does not have it yet. Rerun dotrelay device setup to retry the same key. The account is not recoverable from another device until that succeeds.",
      {},
      "recovery_code_not_published",
    );
  }
  markRecoveryCodeReadyToDisplay(options, authorized.deviceId);
  return {
    deviceId: authorized.deviceId,
    recoveryCode: next.recoveryCode,
    wrapperId: next.wrapperId,
    message:
      "the Account Master Key is set up on this Device; the Recovery Code is shown only once, so store it somewhere safe",
  };
};

export const transferAccountKey = async (
  options: WorkflowOptions,
  recipientDeviceId: string,
): Promise<
  Readonly<{
    readonly deviceId: string;
    readonly transferId: string;
    readonly recipientDeviceId: string;
    readonly expiresAt: string;
    readonly message: string;
  }>
> => {
  const authorized = await loadAuthorizedDevice(options);
  const accountMasterKey = await loadAccountMasterKey(
    options,
    authorized.deviceId,
  );
  if (!accountMasterKey)
    throw new CliError(
      "authentication",
      "this Device is not unlocked; run dotrelay device setup or dotrelay device recover first",
      {},
      "account_key_not_unlocked",
    );
  const peer = authorized.boundary.peerDevices.find(
    (device) => device.id.toLowerCase() === recipientDeviceId.toLowerCase(),
  );
  if (!peer)
    throw new CliError(
      "conflict",
      `device ${recipientDeviceId} is not an active Device for this account`,
      {},
      "transfer_recipient_unknown",
    );
  const recipientX25519PublicKey = hexToBytes(peer.encryptionPublicKey);
  if (recipientX25519PublicKey.length !== 32)
    throw new CliError(
      "transient",
      "the Server Profile returned an invalid peer Device key",
      {},
      "response_invalid",
    );
  const recipientEncryptionPublicKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(recipientX25519PublicKey),
    { name: "X25519" },
    true,
    [],
  );
  const now = Date.now();
  const expiresAtMs = now + accountKeyTransferValidityMs;
  const transfer = await createAccountKeyTransfer({
    serverProfileId: options.profile.pin.serverProfileId,
    userId: uuidToBytes(authorized.userId),
    deviceId: uuidToBytes(authorized.deviceId),
    createdAtMs: now,
    expiresAtMs,
    accountMasterKey,
    recipientDeviceId: peer.id,
    recipientEncryptionPublicKey,
    signingPrivateKey: authorized.keys.signingPrivateKey,
  });
  const operationId = crypto.randomUUID();
  await authorized.admin.post(
    "/api/v1/account-keys/transfers",
    {
      operationId,
      objectId: crypto.randomUUID(),
      object: base64(encodeProtocolObject(transfer.object)),
      recipientDeviceId: peer.id,
      transferId: bytesToHex(transfer.transferId),
      expiresAt: new Date(expiresAtMs).toISOString(),
      ciphertextHash: sha384ToHex(transfer.object.get(48) as Uint8Array),
      ciphertextLength: Number(transfer.object.get(72)),
    },
    ["transferId", "recipientDeviceId", "expiresAt", "idempotent"],
    { idempotencyKey: operationId },
  );
  return {
    deviceId: authorized.deviceId,
    transferId: bytesToHex(transfer.transferId),
    recipientDeviceId: peer.id,
    expiresAt: new Date(expiresAtMs).toISOString(),
    message:
      "the Account Master Key is sealed for the receiving Device; run dotrelay device recover --transfer <id> on that Device before it expires",
  };
};

export const revokeAccountKeyWrapper = async (
  options: WorkflowOptions,
  wrapperId: string,
): Promise<
  Readonly<{
    readonly wrapperId: string;
    readonly revoked: boolean;
    readonly idempotent: boolean;
    readonly message: string;
  }>
> => {
  const authorized = await loadAuthorizedDevice(options);
  const operationId = crypto.randomUUID();
  const result = await authorized.admin.post(
    "/api/v1/account-keys/wrappers/revoke",
    {
      operationId,
      wrapperId: wrapperId.toLowerCase(),
    },
    ["revoked", "idempotent"],
    { idempotencyKey: operationId },
  );
  return {
    wrapperId: wrapperId.toLowerCase(),
    revoked: Boolean(result.revoked),
    idempotent: Boolean(result.idempotent),
    message: result.idempotent
      ? "the Recovery Code wrapper was already revoked"
      : "the Recovery Code wrapper is retired and can no longer unlock the account",
  };
};
