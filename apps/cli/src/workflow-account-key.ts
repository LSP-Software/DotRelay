import { constants } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  accountFingerprint,
  prepareDeviceRecovery,
  authenticatedCreatorKeys,
  createAccountKeyTransfer,
  createAccountKeyWrapper,
  decodeRecoveryCode,
  deviceKeyFingerprint,
  encodeRecoveryCode,
  exportSigningPublicKey,
  formatAccountKeyTransferCode,
  generateAccountMasterKey,
  generateRecoveryCode,
  openAccountKeyTransferWithRoster,
  parseAccountKeyTransfer,
  parseAccountKeyTransferCode,
  parseAccountKeyWrapper,
  sameFingerprint,
  unwrapAccountKeyWrapper,
} from "@dotrelay/client";
import {
  accountKeyTransferAcknowledgementMessage,
  encodeProtocolObject,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";
import { createStrictJsonClient, type StrictJsonClient } from "./admin";
import { deviceMetadataPath, writeDeviceId } from "./device-storage";
import { CliError, CliInvocationError } from "./errors";
import { readTerminalSecret, selectOption } from "./ui";
import {
  establishAccountTrust,
  loadAccountTrustPins,
} from "./workflow-account-trust";
import {
  accountKeyTrustedKeys,
  base64,
  bytesToHex,
  confirmPrompt,
  fromBase64,
  hexToBytes,
  isRecord,
  loadAuthorizedDevice,
  rawPublicKey,
  reportedAccountSigningKeys,
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
      "The server sent a list of account key wrappers this CLI can't read.",
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
  readonly intent: "establish" | "rotate";
};

// Until a run has shown it, the newest Recovery Code waits in the encrypted
// credential store, beside the session and Device keys, so a crash between
// publishing its wrapper and printing it can be retried without minting a
// second code. Earlier versions kept it as a plaintext JSON file in the
// state directory; such a file is moved into the store on first read.
export const PENDING_RECOVERY_CODE_SERVICE = "dotrelay.recovery-code-pending";

const legacyPendingRecoveryPath = (
  options: WorkflowOptions,
  deviceId: string,
): string =>
  join(options.stateDirectory, `recovery-code-pending-${deviceId}.json`);

// Set only after the wrapper publish has succeeded, so the process can
// delete the stored copy once it has written the code to stdout. A failure
// leaves this unset and the code stored for the retry.
let displayedRecoveryCode: (() => Promise<void>) | null = null;

const markRecoveryCodeReadyToDisplay = (
  options: WorkflowOptions,
  deviceId: string,
): void => {
  displayedRecoveryCode = () => clearPresentedRecoveryCode(options, deviceId);
};

export const consumeDisplayedRecoveryCode = ():
  (() => Promise<void>) | null => {
  const clear = displayedRecoveryCode;
  displayedRecoveryCode = null;
  return clear;
};

const parsePendingRecoveryCode = (text: string): PendingRecoveryCode | null => {
  const parsed = JSON.parse(text) as Partial<PendingRecoveryCode>;
  if (
    (parsed.purpose !== "setup" && parsed.purpose !== "rotation") ||
    typeof parsed.recoveryCode !== "string" ||
    typeof parsed.wrapperId !== "string" ||
    typeof parsed.operationId !== "string" ||
    typeof parsed.objectId !== "string" ||
    typeof parsed.object !== "string" ||
    typeof parsed.identityGeneration !== "string" ||
    typeof parsed.ciphertextHash !== "string" ||
    typeof parsed.ciphertextLength !== "number" ||
    (parsed.intent !== "establish" && parsed.intent !== "rotate")
  )
    return null;
  return parsed as PendingRecoveryCode;
};

const writePendingRecoveryCode = async (
  options: WorkflowOptions,
  deviceId: string,
  pending: PendingRecoveryCode,
): Promise<void> => {
  await options.credentials.set(
    PENDING_RECOVERY_CODE_SERVICE,
    deviceId,
    new TextEncoder().encode(JSON.stringify(pending)),
  );
};

const readPendingRecoveryCode = async (
  options: WorkflowOptions,
  deviceId: string,
): Promise<PendingRecoveryCode | null> => {
  const stored = await options.credentials.get(
    PENDING_RECOVERY_CODE_SERVICE,
    deviceId,
  );
  if (stored) {
    try {
      return parsePendingRecoveryCode(new TextDecoder().decode(stored));
    } finally {
      stored.fill(0);
    }
  }
  const legacyPath = legacyPendingRecoveryPath(options, deviceId);
  let legacy: PendingRecoveryCode | null;
  try {
    legacy = parsePendingRecoveryCode(await readFile(legacyPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (legacy) await writePendingRecoveryCode(options, deviceId, legacy);
  await unlink(legacyPath).catch(() => undefined);
  return legacy;
};

export const clearPresentedRecoveryCode = async (
  options: WorkflowOptions,
  deviceId: string,
): Promise<void> => {
  await options.credentials.delete(PENDING_RECOVERY_CODE_SERVICE, deviceId);
  await unlink(legacyPendingRecoveryPath(options, deviceId)).catch(
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
      intent: pending.intent,
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
  intent: "establish" | "rotate",
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
    intent,
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
      "This device doesn't have your account key yet. Run dotrelay device recover.",
      {},
      "account_key_not_unlocked",
    );
  const wrappers = await fetchActiveWrappers(authorized.admin);
  const pending = await readPendingRecoveryCode(options, authorized.deviceId);
  if (pending?.purpose === "setup")
    throw new CliError(
      "conflict",
      "A recovery code from dotrelay device setup hasn't reached the server yet. Run dotrelay device setup again to finish it before you replace the code.",
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
          "The new recovery code didn't reach the server, so your old recovery code still works. Run dotrelay device backup again to retry with the same new code.",
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
        "Your new recovery code is active and the old one no longer works. This code is shown only once, so store it somewhere safe.",
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
    "rotate",
  );
  await writePendingRecoveryCode(options, authorized.deviceId, next);
  try {
    await publishRecoveryWrapper(authorized.admin, next);
  } catch {
    throw new CliError(
      "transient",
      "The new recovery code didn't reach the server, so your old recovery code still works. Run dotrelay device backup again to retry with the same new code.",
      {},
      "recovery_code_not_published",
    );
  }
  markRecoveryCodeReadyToDisplay(options, authorized.deviceId);
  return {
    recoveryCode: next.recoveryCode,
    wrapperId: next.wrapperId,
    message:
      "Your new recovery code is active and the old one no longer works. This code is shown only once, so store it somewhere safe.",
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
      // Open first (O_NOFOLLOW refuses a symlink), then check the opened
      // file itself, so nothing can be swapped in between the check and the
      // read. A symlink or non-regular file never qualifies as a 0600 secret.
      const handle = await open(
        path,
        process.platform === "win32"
          ? constants.O_RDONLY
          : constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("not a regular file");
        if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)
          throw new Error("wrong mode");
        file = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT")
        throw new CliError(
          "local-io",
          `There's no recovery code file at ${path}.`,
          {},
          "recovery_code_file_missing",
        );
      if (code === "EACCES")
        throw new CliError(
          "local-io",
          `You don't have permission to read the recovery code file at ${path}.`,
          {},
          "recovery_code_file_invalid",
        );
      throw new CliError(
        "local-io",
        `The recovery code file must be a regular file with mode 0600, not a symlink: ${path}. If it's a regular file, run chmod 600 on it.`,
        {},
        "recovery_code_file_invalid",
      );
    }
    return file.trim();
  }
  if (options.noInput)
    throw new CliError(
      "invocation",
      "With --no-input, the CLI can't ask for your recovery code. Pass --recovery-code-file <path>, or pipe the code on stdin.",
      {},
      "recovery_code_required",
    );
  return await readTerminalSecret("Recovery code", {
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
      "Use --recovery-code-file <path> or --transfer <transfer-code> with dotrelay device recover, not both.",
    );
  try {
    await enrollFirstDevice(options);
  } catch (error) {
    if (
      hasTransfer ||
      !(error instanceof CliError) ||
      ![
        "state_conflict",
        "device_bundle_missing",
        "device_bundle_invalid",
        "device_not_active",
      ].includes(error.code)
    )
      throw error;
    // The old Device may be lost while still ACTIVE on the service. Prove
    // possession of the recovery secret instead of requiring its approval.
    const admin =
      options.admin ??
      createStrictJsonClient(options.profile.pin, options.credentials, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.networkPolicy
          ? { networkPolicy: options.networkPolicy }
          : {}),
      });
    const session = await admin.get("/api/v1/session", [
      "authenticated",
      "user",
    ]);
    if (!isRecord(session.user) || typeof session.user.id !== "string")
      throw error;
    const wrappers = await fetchActiveWrappers(admin);
    const entry = wrappers.find(
      (candidate) => candidate.type === "recovery-code",
    );
    if (!entry?.creatorPublicKey)
      throw new CliError(
        "authentication",
        "Your account has no recovery code this machine can use. Send the account key from a device you already use with dotrelay device transfer.",
        {},
        "account_key_unlock_failed",
      );
    const codeText = await readRecoveryCode(options, input.recoveryCodeFile);
    let code: Uint8Array;
    try {
      code = decodeRecoveryCode(codeText);
    } catch {
      throw new CliError(
        "invocation",
        "That isn't a valid recovery code. A recovery code is 13 groups of 4 letters and numbers.",
        {},
        "recovery_code_malformed",
      );
    }
    let prepared: Awaited<ReturnType<typeof prepareDeviceRecovery>>;
    try {
      prepared = await prepareDeviceRecovery({
        pin: options.profile.pin,
        userId: session.user.id,
        recoveryCode: code,
        wrapperBytes: fromBase64(entry.object, "recovery code wrapper"),
        creatorPublicKey: hexToBytes(entry.creatorPublicKey),
      });
    } catch {
      throw new CliError(
        "authentication",
        "That recovery code didn't open your account key. Check the code and try again. If it's an older code, replace it first with dotrelay device backup on a device you already use.",
        {},
        "account_key_unlock_failed",
      );
    } finally {
      code.fill(0);
    }
    const storage = resolveDeviceStorage(options);
    await storage.save(prepared.bootstrap.bundle);
    await storage.saveAccountKey(
      accountKeyScope(options, prepared.bootstrap.deviceId),
      prepared.accountMasterKey,
    );
    await writeDeviceId(
      deviceMetadataPath(options.stateDirectory, options.profile.pin),
      options.profile.pin,
      prepared.bootstrap.deviceId,
    );
    await admin.post("/api/v1/devices/bootstrap", prepared.request, [
      "deviceId",
      "identityGeneration",
      "active",
    ]);
    return {
      deviceId: prepared.bootstrap.deviceId,
      via: "recovery-code",
      message:
        "Recovered this device with your recovery code. It now holds your account key.",
    };
  }
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
        "That isn't a valid recovery code. A recovery code is 13 groups of 4 letters and numbers.",
        {},
        "recovery_code_malformed",
      );
    }
    const wrappers = await fetchActiveWrappers(authorized.admin);
    const entry = wrappers.find((wrapper) => wrapper.type === "recovery-code");
    if (!entry)
      throw new CliError(
        "conflict",
        "Your account has no active recovery code. Create one with dotrelay device backup or in the web app.",
        {},
        "recovery_wrapper_missing",
      );
    let wrapper: ReturnType<typeof parseAccountKeyWrapper>;
    try {
      wrapper = parseAccountKeyWrapper(
        fromBase64(entry.object, "recovery code wrapper"),
      );
    } catch {
      throw new CliError(
        "transient",
        "The server sent a recovery code wrapper this CLI can't read.",
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
            authenticatedCreatorKeys(
              entry.creatorPublicKey ? [entry.creatorPublicKey] : [],
              reportedAccountSigningKeys(authorized.boundary),
            ),
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
        "That recovery code didn't open your account key. Check the code and try again.",
        {},
        "account_key_unlock_failed",
      );
    }
    via = "recovery-code";
  } else {
    let code: ReturnType<typeof parseAccountKeyTransferCode>;
    try {
      code = parseAccountKeyTransferCode(input.transferId as string);
    } catch {
      throw new CliInvocationError(
        "That isn't a valid transfer code. Use the code the sending device printed: 32 hex digits, a dot, then the 40-digit account fingerprint.",
      );
    }
    // Without a prompt only the code can carry the fingerprint, so a bare
    // transfer id is refused before the transfer is fetched.
    if (code.accountFingerprint === null && options.noInput)
      throw new CliError(
        "invocation",
        "With --no-input, pass the whole transfer code the sending device printed. It ends with the account fingerprint this device checks.",
        {},
        "account_fingerprint_required",
      );
    const transferId = code.transferId;
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
          "This transfer isn't waiting anymore, or it expired. Run dotrelay device transfer again on the sending device.",
          {},
          "state_conflict",
        );
      throw error;
    }
    let transfer: ReturnType<typeof parseAccountKeyTransfer>;
    try {
      transfer = parseAccountKeyTransfer(
        fromBase64(result.object, "account key transfer"),
      );
    } catch {
      throw new CliError(
        "transient",
        "The server sent an account key transfer this CLI can't read.",
        {},
        "response_invalid",
      );
    }
    // The transfer is sealed to this Device's public key, so its signature
    // is the only evidence of the sender. Only a roster signed by the
    // account key it carries, listing the sender and this Device, vouches
    // for it (ADR 0022); a key list from the service never does.
    const pins = await loadAccountTrustPins(options);
    const pinnedIdentity =
      pins.own && pins.own.userId === authorized.userId
        ? hexToBytes(pins.own.identity)
        : null;
    const servedRoster = authorized.boundary.accountRosters.get(
      authorized.userId,
    );
    let opened: Awaited<ReturnType<typeof openAccountKeyTransferWithRoster>>;
    try {
      opened = await openAccountKeyTransferWithRoster(
        transfer,
        authorized.keys.encryptionPrivateKey,
        {
          serverProfileId: options.profile.pin.serverProfileId,
          userId: authorized.userId,
          device: {
            deviceId: authorized.deviceId,
            encryptionPublicKey: await rawPublicKey(
              authorized.keys.encryptionPublicKey as CryptoKey,
            ),
            signingPublicKey: await rawPublicKey(
              authorized.keys.signingPublicKey as CryptoKey,
            ),
          },
          nowMs: Date.now(),
          roster:
            typeof servedRoster === "string"
              ? fromBase64(servedRoster, "account device roster")
              : null,
          expectedIdentity: pinnedIdentity,
        },
      );
    } catch {
      throw new CliError(
        "crypto",
        "This device couldn't open the transfer. The sending device has to list this device in your signed device roster. Run dotrelay device transfer on the sending device again.",
        {},
        "account_key_transfer_invalid",
      );
    }
    const fingerprint = await accountFingerprint(opened.identity);
    const refuse = (error: Error): never => {
      opened.accountMasterKey.fill(0);
      throw error;
    };
    if (code.accountFingerprint !== null) {
      if (!sameFingerprint(code.accountFingerprint, fingerprint))
        refuse(
          new CliError(
            "crypto",
            "The account key in this transfer doesn't match the fingerprint in the transfer code. Nothing was saved. Don't trust this server until you've checked it.",
            {},
            "account_fingerprint_mismatch",
          ),
        );
    } else if (
      !(await confirmPrompt(
        options,
        `This transfer carries the account key with fingerprint ${fingerprint}. Does that match the account fingerprint on the sending device?`,
      ).catch((error: unknown) => refuse(error as Error)))
    )
      refuse(
        new CliInvocationError("You declined the transfer. Nothing was saved."),
      );
    accountMasterKey = opened.accountMasterKey;
    via = "transfer";
  }
  await storage.saveAccountKey(
    accountKeyScope(options, authorized.deviceId),
    accountMasterKey,
  );
  if (via === "transfer") {
    const { transferId } = parseAccountKeyTransferCode(
      input.transferId as string,
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        authorized.keys.signingPrivateKey,
        accountKeyTransferAcknowledgementMessage(hexToBytes(transferId)),
      ),
    );
    await authorized.admin.post(
      `/api/v1/account-keys/transfers/${transferId}/acknowledge`,
      { signature: base64(signature) },
      ["acknowledged", "idempotent"],
    );
  }
  return {
    deviceId: authorized.deviceId,
    via,
    message:
      via === "recovery-code"
        ? "Opened your account key with the recovery code. This device now stores it."
        : "Received your account key from your other device. This device now stores it.",
  };
};

// Account Master Key establishment, handoff, and recovery-wrapper lifecycle
// are driven from the CLI for headless Devices. The browser keeps the AMK
// in-memory only, so a CLI Device is the surface that persists it; these
// commands cover the same lifecycle a browser session would, through the
// production /api/v1/account-keys/* routes.

// A transfer is sealed for a single peer Device. Accepting it can be retried
// until that Device acknowledges it or the transfer expires; acknowledgement
// is what makes it unusable. The validity window stays far below the service's
// staging TTL.
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
        "A recovery code is waiting on this device, but the account key it protects isn't saved here. The account can't be recovered from this device.",
        {},
        "account_key_not_saved",
      );
    if (!wrappers.some((wrapper) => wrapper.wrapperId === pending.wrapperId)) {
      try {
        await publishRecoveryWrapper(authorized.admin, pending);
      } catch (error) {
        if (error instanceof CliError && error.code === "state_conflict") {
          await storage.clearAccountKey(scope);
          await clearPresentedRecoveryCode(options, authorized.deviceId);
          throw new CliError(
            "conflict",
            "Your account already has an account key, so this device threw away the one it made. Run dotrelay device recover to get the existing key.",
            {},
            "account_key_already_exists",
          );
        }
        throw new CliError(
          "transient",
          "The recovery code is saved on this device, but the server doesn't have it yet. Run dotrelay device setup again to retry with the same key. Until that works, the account can't be recovered from another device.",
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
        "Your account key is set up on this device. Your recovery code is shown only once, so store it somewhere safe.",
    };
  }
  if (!existing && wrappers.length > 0)
    throw new CliError(
      "conflict",
      "Your account already has an account key. Run dotrelay device recover to get it from a device you already use.",
      {},
      "account_key_already_exists",
    );
  if (existing && wrappers.some((wrapper) => wrapper.type === "recovery-code"))
    return {
      deviceId: authorized.deviceId,
      message:
        "This device already holds your account key, and your account has a recovery code. Nothing to set up.",
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
    "establish",
  );
  await writePendingRecoveryCode(options, authorized.deviceId, next);
  try {
    await publishRecoveryWrapper(authorized.admin, next);
  } catch (error) {
    if (error instanceof CliError && error.code === "state_conflict") {
      await storage.clearAccountKey(scope);
      await clearPresentedRecoveryCode(options, authorized.deviceId);
      throw new CliError(
        "conflict",
        "Your account already has an account key, so this device threw away the one it made. Run dotrelay device recover to get the existing key.",
        {},
        "account_key_already_exists",
      );
    }
    throw new CliError(
      "transient",
      "The recovery code is saved on this device, but the server doesn't have it yet. Run dotrelay device setup again to retry with the same key. Until that works, the account can't be recovered from another device.",
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
      "Your account key is set up on this device. Your recovery code is shown only once, so store it somewhere safe.",
  };
};

export const transferAccountKey = async (
  options: WorkflowOptions,
  recipientDeviceId: string,
): Promise<
  Readonly<{
    readonly deviceId: string;
    readonly transferId: string;
    readonly transferCode: string;
    readonly accountFingerprint: string;
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
      "This device doesn't have your account key, so it can't send it. Run dotrelay device setup or dotrelay device recover first.",
      {},
      "account_key_not_unlocked",
    );
  const self = {
    deviceId: authorized.deviceId,
    encryptionPublicKey: await rawPublicKey(
      authorized.keys.encryptionPublicKey as CryptoKey,
    ),
    signingPublicKey: await rawPublicKey(
      authorized.keys.signingPublicKey as CryptoKey,
    ),
  };
  const establish = (
    approved?: Parameters<typeof establishAccountTrust>[0]["approved"],
  ) =>
    establishAccountTrust({
      options,
      boundary: authorized.boundary,
      userId: authorized.userId,
      deviceId: authorized.deviceId,
      accountMasterKey,
      encryptionPublicKey: self.encryptionPublicKey,
      signingPublicKey: self.signingPublicKey,
      ...(approved ? { approved } : {}),
    });
  // The Account Master Key goes only to a Device in this account's signed
  // roster, with the keys that roster lists (ADR 0022).
  const rosterOf = (trust: Awaited<ReturnType<typeof establish>>) => {
    const own = trust.resolution.users.get(authorized.userId);
    if (own?.status !== "verified" || !own.roster)
      throw new CliError(
        "crypto",
        "Couldn't verify your signed device roster, so the account key wasn't sent. Run dotrelay pull, then try again.",
        {},
        "account_roster_untrusted",
      );
    return { roster: own.roster, identity: own.identity ?? new Uint8Array() };
  };
  const trusted = rosterOf(await establish());
  const reported = authorized.boundary.peerDevices;
  let recipient = recipientDeviceId.trim().toLowerCase();
  if (!recipient) {
    if (options.noInput)
      throw new CliInvocationError(
        "With --no-input, pass --to <peer-device-id> to say which device gets the account key.",
      );
    if (reported.length === 0)
      throw new CliError(
        "conflict",
        "Your account has no other active device to send the key to.",
        {},
        "transfer_recipient_unknown",
      );
    recipient = (
      await selectOption(
        "Device to receive the key",
        reported.map((device) => ({
          id: device.id,
          // A human label where the Device has one (the Devices table in the
          // web app shows the same), a bare id where it does not.
          label: device.name ?? device.clientSummary ?? device.id,
          detail: [
            trusted.roster.devices.some(
              (listed) =>
                listed.deviceId === device.id.toLowerCase() &&
                listed.revokedAtMs === undefined,
            )
              ? "in your signed device roster"
              : "not in your signed device roster yet",
            ...(device.hasEpochGrant ? ["holds the project key"] : []),
          ].join(" · "),
        })),
        {
          ...(options.terminal ? { terminal: options.terminal } : {}),
          ...(options.prompt ? { prompt: options.prompt } : {}),
          noInput: options.noInput,
          // Sending the key to the wrong Device is the mistake this list exists
          // to prevent, so an empty answer does not pick the first row.
          defaultToFirst: false,
        },
      )
    ).toLowerCase();
  }
  let listed = trusted.roster.devices.find(
    (device) =>
      device.deviceId === recipient && device.revokedAtMs === undefined,
  );
  if (!listed) {
    if (trusted.roster.devices.some((device) => device.deviceId === recipient))
      throw new CliError(
        "conflict",
        `Device ${recipient} is revoked in your signed device roster, so it can't get the account key.`,
        {},
        "transfer_recipient_unknown",
      );
    // Not rostered yet: the user compares the key fingerprint the service
    // reports with the one that Device shows, and only then is it added.
    const peer = reported.find(
      (device) => device.id.toLowerCase() === recipient,
    );
    if (!peer)
      throw new CliError(
        "conflict",
        `Device ${recipient} isn't an active device on your account.`,
        {},
        "transfer_recipient_unknown",
      );
    let candidate: Readonly<{
      deviceId: string;
      encryptionPublicKey: Uint8Array;
      signingPublicKey: Uint8Array;
      addedAtMs: number;
    }>;
    try {
      candidate = {
        deviceId: recipient,
        encryptionPublicKey: hexToBytes(peer.encryptionPublicKey),
        signingPublicKey: hexToBytes(peer.signingPublicKey),
        addedAtMs: Date.now(),
      };
      if (
        candidate.encryptionPublicKey.length !== 32 ||
        candidate.signingPublicKey.length !== 32
      )
        throw new Error("bad key");
    } catch {
      throw new CliError(
        "transient",
        "The server sent an invalid key for that device. The account key wasn't sent.",
        {},
        "response_invalid",
      );
    }
    const fingerprint = await deviceKeyFingerprint(candidate);
    if (options.noInput)
      throw new CliError(
        "conflict",
        `Device ${recipient} isn't in your signed device roster yet. Run dotrelay device transfer without --no-input to compare its key fingerprint, or approve its enrollment from this device.`,
        {},
        "transfer_recipient_unverified",
      );
    if (
      !(await confirmPrompt(
        options,
        `Device ${recipient} isn't in your signed device roster yet. The server reports its key fingerprint as ${fingerprint}. Run dotrelay device list on that device to see its own. If they match, add it to your roster and send it the account key?`,
      ))
    )
      throw new CliInvocationError(
        "You declined. The account key wasn't sent.",
      );
    const extended = rosterOf(await establish([candidate]));
    listed = extended.roster.devices.find(
      (device) =>
        device.deviceId === recipient && device.revokedAtMs === undefined,
    );
    if (!listed)
      throw new CliError(
        "transient",
        "Couldn't add the device to your signed device roster. Try again.",
        {},
        "account_roster_untrusted",
      );
  }
  const recipientEncryptionPublicKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(listed.encryptionPublicKey),
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
    recipientDeviceId: listed.deviceId,
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
      recipientDeviceId: listed.deviceId,
      transferId: bytesToHex(transfer.transferId),
      expiresAt: new Date(expiresAtMs).toISOString(),
      ciphertextHash: sha384ToHex(transfer.object.get(48) as Uint8Array),
      ciphertextLength: Number(transfer.object.get(72)),
    },
    ["transferId", "recipientDeviceId", "expiresAt", "idempotent"],
    { idempotencyKey: operationId },
  );
  const fingerprint = await accountFingerprint(trusted.identity);
  const transferCode = formatAccountKeyTransferCode(
    bytesToHex(transfer.transferId),
    fingerprint,
  );
  return {
    deviceId: authorized.deviceId,
    transferId: bytesToHex(transfer.transferId),
    transferCode,
    accountFingerprint: fingerprint,
    recipientDeviceId: listed.deviceId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    message: `Sealed your account key for the other device. On that device, run dotrelay device recover --transfer ${transferCode} before the code expires. The code ends with your account fingerprint, which that device checks.`,
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
  let id = wrapperId.trim();
  if (!id) {
    if (options.noInput)
      throw new CliInvocationError(
        "With --no-input, pass --wrapper-id <id> to say which wrapper to revoke.",
      );
    const active = await fetchActiveWrappers(authorized.admin);
    // The service keeps at least one Recovery Code wrapper and at least one
    // wrapper of any kind active (ADR 0009), so the list offers only the
    // wrappers whose revocation can succeed.
    const recoveryCodeCount = active.filter(
      (wrapper) => wrapper.type === "recovery-code",
    ).length;
    const revocable = active.filter(
      (wrapper) =>
        active.length > 1 &&
        (wrapper.type !== "recovery-code" || recoveryCodeCount > 1),
    );
    if (revocable.length === 0)
      throw new CliError(
        "conflict",
        "There's no wrapper you can revoke. Your account has to keep at least one recovery code wrapper and at least one wrapper of any kind active.",
        {},
        "state_conflict",
      );
    id = await selectOption(
      "Wrapper to revoke",
      revocable.map((wrapper) => ({
        id: wrapper.wrapperId,
        label: wrapper.wrapperId,
        detail:
          wrapper.type === "recovery-code"
            ? "Recovery code wrapper"
            : wrapper.type === "password"
              ? "Encryption password wrapper"
              : "Passkey wrapper",
      })),
      {
        ...(options.terminal ? { terminal: options.terminal } : {}),
        ...(options.prompt ? { prompt: options.prompt } : {}),
        noInput: options.noInput,
        // Revoking the wrong wrapper retires a recovery route, so an empty
        // answer does not pick the first row.
        defaultToFirst: false,
      },
    );
  }
  const operationId = crypto.randomUUID();
  const result = await authorized.admin.post(
    "/api/v1/account-keys/wrappers/revoke",
    {
      operationId,
      wrapperId: id.toLowerCase(),
    },
    ["revoked", "idempotent"],
    { idempotencyKey: operationId },
  );
  return {
    wrapperId: id.toLowerCase(),
    revoked: Boolean(result.revoked),
    idempotent: Boolean(result.idempotent),
    message: result.idempotent
      ? "That wrapper was already revoked."
      : "Revoked the wrapper. It can't unlock your account key anymore.",
  };
};
