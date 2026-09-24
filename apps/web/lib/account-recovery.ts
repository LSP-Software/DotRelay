import {
  authenticatedCreatorKeys,
  createBrowserDeviceStorage,
  createPasskeyWithPrf,
  deviceHistorySigningKeys,
  loadDeviceKeyMaterial,
  PasskeyPrfError,
  parseAccountKeyWrapper,
  runPasskeyAssertion,
  uuidToBytes,
} from "@dotrelay/client";
import {
  type AccountKeyActor,
  AccountKeyRequestError,
  type AccountKeyTrustedKeys,
  type AccountKeyVerificationContext,
  type AccountKeyWrapperEntry,
  acceptAccountKeyTransfer,
  accountKeyTransferAcknowledgementMessage,
  accountKeyTrustedKeys,
  accountKeyVerificationContext,
  acknowledgeAccountKeyTransfer,
  fromBase64 as akFromBase64,
  bytesToHex,
  createAccountKeyEnvelope,
  createAccountKeyTransfer,
  createAccountKeyWrapper,
  encodeRecoveryCode,
  fetchAccountKeyWrappers,
  generateAccountMasterKey,
  generateRecoveryCode,
  hexToBytes,
  openAccountKeyTransferForDevice,
  openProjectEpochEnvelope,
  publishAccountKeyEnvelope,
  publishAccountKeyWrapper,
  revokeAccountKeyWrapper,
  stageAccountKeyTransfer,
  UNLOCK_FAILURE,
  unlockWithPasskeyPrf,
  unlockWithPassword,
  unlockWithRecoveryCode,
} from "@/lib/account-keys";
import type { WorkspaceBoundary } from "@/lib/workspace-boundary";

// In-browser Account Key recovery: the orchestration behind unlocking the
// Account Master Key, setting up, rotating, and managing its recovery
// methods, and offering key transfers to peer Devices.
//
// The React layer owns the inputs (the boundary, the acting account, the
// listed wrappers, passkey availability) and the feedback (busy/message/
// error/code feedback, the unlock flag, and the generation bump that
// re-runs the wrapper refresh and session load). It also owns the key
// itself: a ref kept out of state, reached here only through the vault
// adapter, so the key bytes can never trigger a render.
//
// Every mutation takes a caller-stable operationId that doubles as the
// Idempotency-Key, so retrying the same logical attempt replays the
// commit instead of double-publishing. A failed commit keeps the prior
// UI state and re-offers the action, so the user never sees a
// half-applied state.

export type AccountRecoveryUnlockMethod =
  | "recovery-code"
  | "password"
  | "passkey-prf"
  | "transfer";

// The in-memory Account Master Key, held by the page in a ref and
// accessed through this adapter so the key bytes never enter React state.
export type AccountKeyVault = Readonly<{
  readonly read: () => Uint8Array | null;
  readonly write: (key: Uint8Array) => void;
  readonly clear: () => void;
}>;

export type AccountRecoveryInputs = Readonly<{
  readonly actor: AccountKeyActor | null;
  readonly boundary: WorkspaceBoundary;
  readonly wrappers: readonly AccountKeyWrapperEntry[];
  readonly accountMasterKey: AccountKeyVault;
  readonly passkeyAvailable: boolean;
}>;

export type AccountRecoveryFeedback = Readonly<{
  readonly setBusy: (busy: boolean) => void;
  readonly setMessage: (message: string | null) => void;
  readonly setError: (error: string | null) => void;
  readonly setCode: (code: string | null, note: string | null) => void;
  readonly clearInputs: () => void;
  readonly setAccountUnlocked: (unlocked: boolean) => void;
}>;

// A completed recovery mutation: the key's bytes changed in memory or a
// wrapper/envelope/transfer commit landed, so the page re-derives the
// session's project keys through the envelope path.
export type AccountRecoveryOnMutated = () => void;

// Transport-only failures - a server problem response (whose message is
// always the internal "The server rejected the request.") and a failed
// fetch (the browser's "Failed to fetch") - never carry copy a user
// should read: the operation's own fallback is shown instead. Human-
// authored errors (UNLOCK_FAILURE, local validation text) pass through.
export const recoveryErrorMessage = (
  error: unknown,
  fallback: string,
): string => {
  if (error instanceof AccountKeyRequestError) return fallback;
  if (error instanceof TypeError) return fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};

const asArrayBuffer = (input: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
};

// The stored Device's bundle (user identity, identity generation), needed
// to name wrappers and transfers on this account's behalf.
const loadRecoveryBundle = async (
  inputs: Pick<AccountRecoveryInputs, "boundary">,
): Promise<{
  readonly userId: Uint8Array;
  readonly userIdentityGeneration: number;
}> => {
  const profile = inputs.boundary.profile;
  const device = inputs.boundary.device;
  const pin = {
    serverProfileId: profile.serverProfileId ?? "",
    origin: profile.origin,
  };
  const bundle = await createBrowserDeviceStorage(pin).load({
    pin,
    deviceId: uuidToBytes(device.id ?? ""),
  });
  return {
    userId: bundle.userId,
    userIdentityGeneration: bundle.userIdentityGeneration,
  };
};

// The signature trust set for a workspace boundary's account-key objects:
// the boundary's trust keys and devices, the device's own key, every peer
// device, plus any creator key the service named on a listed wrapper.
export const accountKeyVerification = (
  boundary: WorkspaceBoundary,
  wrappers: readonly AccountKeyWrapperEntry[],
): Readonly<{
  readonly trustedKeys: AccountKeyTrustedKeys;
  readonly context: AccountKeyVerificationContext;
}> | null => {
  const device = boundary.device;
  if (
    !boundary.session.userId ||
    !boundary.profile.serverProfileId ||
    !device.id ||
    !device.signingPublicKey
  )
    return null;
  try {
    const localSigningKey = hexToBytes(device.signingPublicKey);
    return Object.freeze({
      trustedKeys: accountKeyTrustedKeys(
        boundary,
        localSigningKey,
        authenticatedCreatorKeys(
          wrappers.flatMap((entry) =>
            entry.creatorPublicKey ? [entry.creatorPublicKey] : [],
          ),
          deviceHistorySigningKeys(boundary),
        ),
      ),
      context: accountKeyVerificationContext(boundary),
    });
  } catch {
    return null;
  }
};

// The stored Device's signing key, needed to create wrappers, envelopes,
// and transfers on this account's behalf.
export const loadDeviceSigningKey = async (
  boundary: WorkspaceBoundary,
): Promise<CryptoKey | null> => {
  const profile = boundary.profile;
  const device = boundary.device;
  if (!profile.serverProfileId || !device.id) return null;
  const pin = {
    serverProfileId: profile.serverProfileId,
    origin: profile.origin,
  };
  try {
    const bundle = await createBrowserDeviceStorage(pin).load({
      pin,
      deviceId: uuidToBytes(device.id),
    });
    return (await loadDeviceKeyMaterial(bundle)).signingPrivateKey;
  } catch {
    return null;
  }
};

// Unlock the Account Master Key from one of the account's methods. Every
// failure collapses to the uniform message so the UI never reveals which
// check rejected the attempt; a success holds the key in memory for the
// page session and bumps the generation so the session loader re-derives
// the project's keys through the envelope path.
export const unlockAccount = async (
  inputs: AccountRecoveryInputs,
  method: AccountRecoveryUnlockMethod,
  secret: string,
  feedback: AccountRecoveryFeedback,
  onMutated: AccountRecoveryOnMutated,
): Promise<void> => {
  const { actor, boundary, wrappers, accountMasterKey, passkeyAvailable } =
    inputs;
  const verification = accountKeyVerification(boundary, wrappers);
  if (!actor || !verification) {
    feedback.setError(
      "This browser's device keys aren't available, so it can't verify that. Set up this browser first.",
    );
    return;
  }
  feedback.setBusy(true);
  feedback.setError(null);
  feedback.setMessage(null);
  try {
    let accountMasterKeyBytes: Uint8Array;
    if (method === "recovery-code" || method === "password") {
      const entry = wrappers.find(
        (wrapper) =>
          wrapper.type ===
          (method === "recovery-code" ? "recovery-code" : "password"),
      );
      if (!entry) throw new Error(UNLOCK_FAILURE);
      accountMasterKeyBytes =
        method === "recovery-code"
          ? (await unlockWithRecoveryCode(entry, secret, verification))
              .accountMasterKey
          : (await unlockWithPassword(entry, secret, verification))
              .accountMasterKey;
    } else if (method === "passkey-prf") {
      const entry = wrappers.find((wrapper) => wrapper.type === "passkey-prf");
      if (!entry || !passkeyAvailable) throw new Error(UNLOCK_FAILURE);
      const parsed = parseAccountKeyWrapper(akFromBase64(entry.object));
      const credentialId = parsed.credentialId;
      const prfInput = parsed.prfInput;
      if (!credentialId || !prfInput) throw new Error(UNLOCK_FAILURE);
      // A genuine passkey assertion: the platform runs the user-verification
      // prompt and evaluates the stored passkey's PRF over the stored input,
      // so the 32-byte output that seals the wrapper derives from the
      // credential. The credential response never leaves the browser, and
      // the PRF output is never stored or transmitted.
      const prfOutput = await runPasskeyAssertion(
        globalThis,
        credentialId,
        prfInput,
      );
      accountMasterKeyBytes = (
        await unlockWithPasskeyPrf(entry, prfOutput, verification)
      ).accountMasterKey;
    } else {
      const accepted = await acceptAccountKeyTransfer(actor, secret.trim());
      const material = await loadDeviceKeyMaterial(
        await createBrowserDeviceStorage({
          serverProfileId: boundary.profile.serverProfileId ?? "",
          origin: boundary.profile.origin,
        }).load({
          pin: {
            serverProfileId: boundary.profile.serverProfileId ?? "",
            origin: boundary.profile.origin,
          },
          deviceId: uuidToBytes(boundary.device.id ?? ""),
        }),
      );
      const opened = await openAccountKeyTransferForDevice(
        accepted.object,
        material.encryptionPrivateKey,
        {
          trustedKeys: verification.trustedKeys,
          context: verification.context,
          ownDeviceId: uuidToBytes(boundary.device.id ?? ""),
          nowMs: Date.now(),
        },
      );
      accountMasterKeyBytes = opened.accountMasterKey;
      try {
        const signingPrivateKey = await loadDeviceSigningKey(boundary);
        if (signingPrivateKey) {
          const transferId = hexToBytes(secret.trim().toLowerCase());
          const signature = new Uint8Array(
            await globalThis.crypto.subtle.sign(
              { name: "Ed25519" },
              signingPrivateKey,
              accountKeyTransferAcknowledgementMessage(transferId),
            ),
          );
          await acknowledgeAccountKeyTransfer(actor, secret.trim(), signature);
        }
      } catch {
        // The key is already unwrapped. A failed acknowledgement leaves the
        // transfer retryable until it expires.
      }
    }
    accountMasterKey.write(accountMasterKeyBytes);
    feedback.setAccountUnlocked(true);
    feedback.setMessage(
      "This account is unlocked for this browser session. The key stays in memory and is gone when the tab closes; unlock it again next time with one of the methods below.",
    );
    onMutated();
  } catch (error) {
    feedback.setError(
      error instanceof AccountKeyRequestError && error.code === "state_conflict"
        ? "That transfer expired or was already used. Ask the sender to create a new one."
        : error instanceof PasskeyPrfError
          ? error.message
          : error instanceof Error && error.message === UNLOCK_FAILURE
            ? UNLOCK_FAILURE
            : "We couldn't unlock the account. Try again.",
    );
    feedback.clearInputs();
  } finally {
    feedback.setBusy(false);
    onMutated();
  }
};

// A recovery-code ceremony stays in the page until the user confirms
// they saved the code. Nothing is published before that confirmation, and
// a retry reuses this same key, code, wrapper, and operation id. Closing
// the tab before confirmation discards it; a lost publish response is
// retried as the same commit.
export type RecoveryCeremony = {
  readonly purpose: "setup" | "rotation";
  readonly accountMasterKey: Uint8Array;
  readonly codeText: string;
  readonly note: string;
  readonly wrapper: Awaited<ReturnType<typeof createAccountKeyWrapper>>;
  readonly wrapperOperationId: string;
  readonly replacesWrapperId: string | null;
  readonly envelope: Awaited<
    ReturnType<typeof createAccountKeyEnvelope>
  > | null;
  readonly envelopeOperationId: string | null;
  readonly envelopeProjectId: string | null;
  readonly envelopeProjectEpoch: number | null;
  wrapperCommitted: boolean;
  envelopeCommitted: boolean;
};

export type RecoveryCeremonyHolder = {
  current: RecoveryCeremony | null;
};

const SETUP_NOTE =
  "This code is not active until you confirm you saved it. Closing this dialog leaves the account unchanged.";
const ROTATION_NOTE =
  "The current recovery code keeps working until you confirm. This replacement is shown once and is not stored in this browser.";

const presentCeremony = (
  holder: RecoveryCeremonyHolder,
  feedback: AccountRecoveryFeedback,
): void => {
  const ceremony = holder.current;
  if (!ceremony) return;
  feedback.setCode(ceremony.codeText, ceremony.note);
};

const prepareRecoveryCeremony = async (
  inputs: AccountRecoveryInputs,
  purpose: "setup" | "rotation",
): Promise<RecoveryCeremony> => {
  const { actor, boundary } = inputs;
  if (!actor) throw new Error("Sign in before changing recovery.");
  const verification = accountKeyVerification(boundary, inputs.wrappers);
  const signingPrivateKey = await loadDeviceSigningKey(boundary);
  if (!verification || !signingPrivateKey)
    throw new Error(
      "This browser's device keys aren't available, so it can't protect your account. Set up this browser first.",
    );
  const existingKey =
    purpose === "rotation" ? inputs.accountMasterKey.read() : null;
  if (purpose === "rotation" && !existingKey) throw new Error(UNLOCK_FAILURE);
  const accountMasterKey = existingKey ?? (await generateAccountMasterKey());
  const recoveryCode = await generateRecoveryCode();
  const profile = boundary.profile;
  const device = boundary.device;
  const bundle = await loadRecoveryBundle(inputs);
  const wrapper = await createAccountKeyWrapper({
    serverProfileId: profile.serverProfileId ?? "",
    userId: bundle.userId,
    deviceId: uuidToBytes(device.id ?? ""),
    userIdentityGeneration: bundle.userIdentityGeneration,
    createdAtMs: Date.now(),
    accountMasterKey,
    signingPrivateKey,
    kind: { type: "recoveryCode", recoveryCode },
  });
  let envelope: RecoveryCeremony["envelope"] = null;
  let envelopeOperationId: string | null = null;
  let envelopeProjectId: string | null = null;
  let envelopeProjectEpoch: number | null = null;
  const environment = boundary.environment;
  if (purpose === "setup" && environment.projectId) {
    const peerHoldsEpochKey = (boundary.peerDevices ?? []).some(
      (peer) => peer.hasEpochGrant,
    );
    const existingEnvelope =
      (await openProjectEpochEnvelope(
        boundary.accountKeyEnvelope,
        accountMasterKey,
        {
          trustedKeys: verification.trustedKeys,
          context: verification.context,
          projectId: environment.projectId,
          projectEpoch: Number(environment.projectEpoch ?? 1),
        },
      )) ?? null;
    if (
      !boundary.grantsReady &&
      !peerHoldsEpochKey &&
      existingEnvelope === null
    ) {
      const epochKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
      envelopeProjectEpoch = Number(environment.projectEpoch ?? 1);
      envelopeProjectId = environment.projectId;
      envelopeOperationId = globalThis.crypto.randomUUID();
      envelope = await createAccountKeyEnvelope({
        serverProfileId: profile.serverProfileId ?? "",
        userId: bundle.userId,
        deviceId: uuidToBytes(device.id ?? ""),
        createdAtMs: Date.now(),
        accountMasterKey,
        signingPrivateKey,
        kind: {
          type: "projectEpochKey",
          projectId: uuidToBytes(environment.projectId),
          projectEpoch: envelopeProjectEpoch,
          contentKey: epochKey,
        },
      });
    }
  }
  return {
    purpose,
    accountMasterKey,
    codeText: encodeRecoveryCode(recoveryCode),
    note: purpose === "setup" ? SETUP_NOTE : ROTATION_NOTE,
    wrapper,
    wrapperOperationId: globalThis.crypto.randomUUID(),
    replacesWrapperId:
      inputs.wrappers.find((entry) => entry.type === "recovery-code")
        ?.wrapperId ?? null,
    envelope,
    envelopeOperationId,
    envelopeProjectId,
    envelopeProjectEpoch,
    wrapperCommitted: false,
    envelopeCommitted: envelope === null,
  };
};

// Show a recovery code and wait. A later confirmation publishes this exact
// ceremony; calling setup or rotation again while it is still unconfirmed
// shows the same code instead of minting another key.
export const setupAccountRecovery = (
  inputs: AccountRecoveryInputs,
  feedback: AccountRecoveryFeedback,
  onMutated: AccountRecoveryOnMutated,
  holder: RecoveryCeremonyHolder,
): void => {
  const { actor, boundary } = inputs;
  if (!actor || !boundary.session.userId) {
    feedback.setError("Sign in before setting up recovery.");
    return;
  }
  if (holder.current?.purpose === "setup") {
    presentCeremony(holder, feedback);
    return;
  }
  void (async () => {
    feedback.setBusy(true);
    feedback.setError(null);
    feedback.setMessage(null);
    try {
      holder.current = await prepareRecoveryCeremony(inputs, "setup");
      presentCeremony(holder, feedback);
    } catch (error) {
      if (
        error instanceof AccountKeyRequestError &&
        error.code === "state_conflict"
      ) {
        inputs.accountMasterKey.clear();
        feedback.setAccountUnlocked(false);
        feedback.setCode(null, null);
        feedback.setError(
          "Another device already created this account's key. This browser discarded its new key. Unlock with the recovery code from the device that finished setup.",
        );
        return;
      }
      feedback.setError(
        recoveryErrorMessage(error, "We couldn't set up recovery. Try again."),
      );
    } finally {
      feedback.setBusy(false);
      onMutated();
    }
  })();
};

export const rotateRecoveryCode = (
  inputs: AccountRecoveryInputs,
  feedback: AccountRecoveryFeedback,
  onMutated: AccountRecoveryOnMutated,
  holder: RecoveryCeremonyHolder,
): void => {
  const { actor } = inputs;
  if (!actor) {
    feedback.setError(
      "This browser can't change the account's recovery options.",
    );
    return;
  }
  if (
    holder.current?.purpose === "rotation" &&
    !holder.current.wrapperCommitted
  ) {
    presentCeremony(holder, feedback);
    return;
  }
  void (async () => {
    feedback.setBusy(true);
    feedback.setError(null);
    feedback.setMessage(null);
    try {
      holder.current = await prepareRecoveryCeremony(inputs, "rotation");
      presentCeremony(holder, feedback);
    } catch (error) {
      feedback.setError(
        recoveryErrorMessage(
          error,
          "The rotation didn't complete. The old code still works.",
        ),
      );
    } finally {
      feedback.setBusy(false);
      onMutated();
    }
  })();
};

// Publish the ceremony the user just confirmed. A failed or lost response
// leaves the ceremony in place, so the next confirmation retries the same
// wrapper and the same project-key envelope.
export const commitPresentedRecoveryCode = (
  inputs: AccountRecoveryInputs,
  feedback: AccountRecoveryFeedback,
  onMutated: AccountRecoveryOnMutated,
  holder: RecoveryCeremonyHolder,
): void => {
  const ceremony = holder.current;
  const { actor } = inputs;
  if (!ceremony || !actor) return;
  void (async () => {
    feedback.setBusy(true);
    feedback.setError(null);
    try {
      const listed = await fetchAccountKeyWrappers(actor);
      const active = listed.find((entry) => entry.type === "recovery-code");
      const ownWrapperId = bytesToHex(ceremony.wrapper.wrapperId);
      if (
        ceremony.purpose === "setup" &&
        active &&
        active.wrapperId !== ownWrapperId
      ) {
        holder.current = null;
        feedback.setCode(null, null);
        feedback.setError(
          "Another tab already created this account's recovery code. This code was not activated. Unlock with the code from that tab.",
        );
        return;
      }
      if (
        ceremony.purpose === "rotation" &&
        active &&
        active.wrapperId !== ceremony.replacesWrapperId &&
        active.wrapperId !== ownWrapperId
      ) {
        holder.current = null;
        feedback.setCode(null, null);
        feedback.setError(
          "Another tab already replaced the recovery code. The code shown here was not activated.",
        );
        return;
      }
      const bundle = await loadRecoveryBundle(inputs);
      if (!ceremony.wrapperCommitted) {
        await publishAccountKeyWrapper(
          actor,
          ceremony.wrapperOperationId,
          ceremony.wrapper,
          String(bundle.userIdentityGeneration),
          ceremony.purpose === "setup" ? "establish" : "rotate",
        );
        ceremony.wrapperCommitted = true;
      }
      if (
        ceremony.envelope &&
        ceremony.envelopeOperationId &&
        ceremony.envelopeProjectId &&
        ceremony.envelopeProjectEpoch !== null &&
        !ceremony.envelopeCommitted
      ) {
        await publishAccountKeyEnvelope(
          actor,
          ceremony.envelopeOperationId,
          ceremony.envelope,
          {
            envelopeType: "PROJECT_EPOCH_KEY",
            projectId: ceremony.envelopeProjectId,
            projectEpoch: ceremony.envelopeProjectEpoch,
          },
        );
        ceremony.envelopeCommitted = true;
      }
      inputs.accountMasterKey.write(ceremony.accountMasterKey);
      feedback.setAccountUnlocked(true);
      feedback.setCode(null, null);
      holder.current = null;
      feedback.setMessage(
        ceremony.purpose === "rotation"
          ? "Your recovery code was rotated."
          : "Recovery is on. This browser keeps the account's key in memory for this session only; the next visit unlocks it again with the code or another method below.",
      );
    } catch (error) {
      if (
        ceremony.purpose === "setup" &&
        !ceremony.wrapperCommitted &&
        error instanceof AccountKeyRequestError &&
        error.code === "state_conflict"
      ) {
        holder.current = null;
        inputs.accountMasterKey.clear();
        feedback.setAccountUnlocked(false);
        feedback.setCode(null, null);
        feedback.setError(
          "Another device already created this account's key. This browser discarded its new key. Unlock with the recovery code from the device that finished setup.",
        );
        return;
      }
      const published = ceremony.wrapperCommitted;
      feedback.setError(
        published
          ? "The recovery code is active, but the project key was not stored. Confirm the saved code again to retry that same key."
          : "The recovery code was not activated. Nothing changed.",
      );
      if (!published) {
        feedback.setMessage(
          ceremony.purpose === "rotation"
            ? "The previous recovery code still works."
            : null,
        );
      }
      presentCeremony(holder, feedback);
    } finally {
      feedback.setBusy(false);
      onMutated();
    }
  })();
};

export const discardPresentedRecoveryCode = (
  holder: RecoveryCeremonyHolder,
  feedback: AccountRecoveryFeedback,
): void => {
  if (holder.current?.wrapperCommitted) {
    feedback.setError(
      "The recovery code is already active. Confirm again to finish storing the project key.",
    );
    presentCeremony(holder, feedback);
    return;
  }
  holder.current = null;
  feedback.setCode(null, null);
};

export const addEncryptionPassword = (
  inputs: AccountRecoveryInputs,
  password: string,
  feedback: AccountRecoveryFeedback,
  onMutated: AccountRecoveryOnMutated,
  onAdded: () => void,
): void => {
  const { actor, boundary } = inputs;
  if (!actor) {
    feedback.setError(
      "This browser can't change the account's recovery options.",
    );
    return;
  }
  void (async () => {
    const verification = accountKeyVerification(boundary, inputs.wrappers);
    const signingPrivateKey = await loadDeviceSigningKey(boundary);
    const accountMasterKey = inputs.accountMasterKey.read();
    if (!verification || !signingPrivateKey || !accountMasterKey) {
      feedback.setError(
        "Unlock the account in this browser first, then add an encryption password.",
      );
      return;
    }
    if (password.length < 8) {
      feedback.setError("The encryption password needs at least 8 characters.");
      return;
    }
    feedback.setBusy(true);
    feedback.setError(null);
    feedback.setMessage(null);
    try {
      const profile = boundary.profile;
      const device = boundary.device;
      const bundle = await loadRecoveryBundle(inputs);
      const wrapper = await createAccountKeyWrapper({
        serverProfileId: profile.serverProfileId ?? "",
        userId: bundle.userId,
        deviceId: uuidToBytes(device.id ?? ""),
        userIdentityGeneration: bundle.userIdentityGeneration,
        createdAtMs: Date.now(),
        accountMasterKey,
        signingPrivateKey,
        kind: {
          type: "password",
          password: new TextEncoder().encode(password),
        },
      });
      await publishAccountKeyWrapper(
        actor,
        globalThis.crypto.randomUUID(),
        wrapper,
        String(bundle.userIdentityGeneration),
        "add",
      );
      onAdded();
      feedback.setMessage(
        "You can now unlock this account with the encryption password, next to your recovery code.",
      );
    } catch (error) {
      feedback.setError(
        recoveryErrorMessage(error, "The password wasn't added. Try again."),
      );
    } finally {
      feedback.setBusy(false);
      onMutated();
    }
  })();
};

export const removeEncryptionPassword = (
  inputs: AccountRecoveryInputs,
  feedback: AccountRecoveryFeedback,
  onMutated: AccountRecoveryOnMutated,
  onRemoved: () => void,
): void => {
  const { actor, wrappers } = inputs;
  const entry = wrappers.find((wrapper) => wrapper.type === "password");
  if (!actor || !entry) return;
  void (async () => {
    feedback.setBusy(true);
    feedback.setError(null);
    feedback.setMessage(null);
    try {
      await revokeAccountKeyWrapper(
        actor,
        globalThis.crypto.randomUUID(),
        entry.wrapperId,
      );
      onRemoved();
      feedback.setMessage(
        "The encryption password no longer unlocks this account. Your recovery code still works.",
      );
    } catch (error) {
      feedback.setError(
        error instanceof AccountKeyRequestError &&
          error.code === "state_conflict"
          ? "The account keeps at least one recovery method, so the server refused to remove this one. Add another method first, then try again."
          : "The password wasn't removed. Try again.",
      );
    } finally {
      feedback.setBusy(false);
      onMutated();
    }
  })();
};

// Add a passkey that can unlock this account: the browser's authenticator
// creates a credential that supports the WebAuthn PRF extension, and the
// account's key is wrapped under that credential's 32-byte PRF output for a
// fresh, random PRF input. No key rotation: the Account Master Key is
// unchanged, so every existing method (recovery code, password, other
// passkeys, every device) keeps working; the passkey is one more door onto
// the same key. The PRF input is stored in the wrapper, the PRF output is
// ephemeral and never stored or transmitted. A credential that cannot
// deliver the PRF output is discarded by the client module before this
// point, so the account is never offered a passkey that could not unlock
// it.
export const addPasskeyPrf = (
  inputs: AccountRecoveryInputs,
  feedback: AccountRecoveryFeedback,
  onMutated: AccountRecoveryOnMutated,
): void => {
  const { actor, boundary } = inputs;
  if (!actor) {
    feedback.setError(
      "This browser can't change the account's recovery options.",
    );
    return;
  }
  if (!inputs.passkeyAvailable) {
    feedback.setError(
      "This browser can't use the passkey PRF, so it can't add a passkey. On a browser that can, the passkey can still unlock the account from here.",
    );
    return;
  }
  void (async () => {
    const verification = accountKeyVerification(boundary, inputs.wrappers);
    const signingPrivateKey = await loadDeviceSigningKey(boundary);
    const accountMasterKey = inputs.accountMasterKey.read();
    if (!verification || !signingPrivateKey || !accountMasterKey) {
      feedback.setError(
        "Unlock the account in this browser first, then add a passkey.",
      );
      return;
    }
    feedback.setBusy(true);
    feedback.setError(null);
    feedback.setMessage(null);
    try {
      const bundle = await loadRecoveryBundle(inputs);
      const prfInput = globalThis.crypto.getRandomValues(new Uint8Array(32));
      // The browser runs the real passkey creation ceremony (user
      // verification included) and confirms the new credential can evaluate
      // the PRF; only then is a wrapper published. If the prompt is
      // cancelled, nothing changed.
      const created = await createPasskeyWithPrf(
        globalThis,
        prfInput,
        bundle.userId,
      );
      const wrapper = await createAccountKeyWrapper({
        serverProfileId: boundary.profile.serverProfileId ?? "",
        userId: bundle.userId,
        deviceId: uuidToBytes(boundary.device.id ?? ""),
        userIdentityGeneration: bundle.userIdentityGeneration,
        createdAtMs: Date.now(),
        accountMasterKey,
        signingPrivateKey,
        kind: {
          type: "passkeyPrf",
          credentialId: created.credentialId,
          prfInput,
          prfOutput: created.prfOutput,
        },
      });
      await publishAccountKeyWrapper(
        actor,
        globalThis.crypto.randomUUID(),
        wrapper,
        String(bundle.userIdentityGeneration),
        "add",
      );
      feedback.setMessage(
        "You can now unlock this account with the passkey, next to your recovery code.",
      );
    } catch (error) {
      feedback.setError(
        error instanceof PasskeyPrfError
          ? error.message
          : recoveryErrorMessage(error, "The passkey wasn't added. Try again."),
      );
    } finally {
      feedback.setBusy(false);
      onMutated();
    }
  })();
};

export const removePasskeyPrf = (
  inputs: AccountRecoveryInputs,
  feedback: AccountRecoveryFeedback,
  onMutated: AccountRecoveryOnMutated,
  onRemoved: () => void,
): void => {
  const { actor, wrappers } = inputs;
  const entry = wrappers.find((wrapper) => wrapper.type === "passkey-prf");
  if (!actor || !entry) return;
  void (async () => {
    feedback.setBusy(true);
    feedback.setError(null);
    feedback.setMessage(null);
    try {
      await revokeAccountKeyWrapper(
        actor,
        globalThis.crypto.randomUUID(),
        entry.wrapperId,
      );
      onRemoved();
      feedback.setMessage(
        "The passkey no longer unlocks this account. Your recovery code still works.",
      );
    } catch (error) {
      feedback.setError(
        error instanceof AccountKeyRequestError &&
          error.code === "state_conflict"
          ? "The account keeps at least one recovery method, so the server refused to remove this one. Add another method first, then try again."
          : "The passkey wasn't removed. Try again.",
      );
    } finally {
      feedback.setBusy(false);
      onMutated();
    }
  })();
};

// Hand this account's key to one of the User's other Devices: sealed to
// the target's encryption key and staged as a one-time transfer the
// target redeems before it expires. The key stays on this browser, so a
// transfer is an addition, not a move.
export const sendAccountKeyTransfer = (
  inputs: AccountRecoveryInputs,
  transferTargetId: string | null,
  feedback: AccountRecoveryFeedback,
  onMutated: AccountRecoveryOnMutated,
  onStaged: (
    staged: Readonly<{
      readonly transferId: string;
      readonly expiresAt: string;
      readonly recipientDeviceId: string;
    }>,
  ) => void,
): void => {
  const { actor, boundary } = inputs;
  const target = boundary.peerDevices?.find(
    (peer) => peer.id === transferTargetId,
  );
  const accountMasterKey = inputs.accountMasterKey.read();
  if (!actor || !target || !accountMasterKey) {
    feedback.setError(
      "Unlock the account in this browser and choose one of its devices first.",
    );
    return;
  }
  void (async () => {
    const verification = accountKeyVerification(boundary, inputs.wrappers);
    const signingPrivateKey = await loadDeviceSigningKey(boundary);
    if (!verification || !signingPrivateKey) {
      feedback.setError(
        "This browser's device keys aren't available, so it can't send a transfer.",
      );
      return;
    }
    feedback.setBusy(true);
    feedback.setError(null);
    feedback.setMessage(null);
    try {
      const recipientPublicKey = await globalThis.crypto.subtle.importKey(
        "raw",
        asArrayBuffer(hexToBytes(target.encryptionPublicKey)),
        { name: "X25519" },
        false,
        [],
      );
      const profile = boundary.profile;
      const device = boundary.device;
      const bundle = await loadRecoveryBundle(inputs);
      // Transfers are short-lived by design: the receiver redeems it on
      // its own schedule, and an unclaimed one stops being redeemable
      // once the window lapses.
      const validityMs = 5 * 60 * 1000;
      const transfer = await createAccountKeyTransfer({
        serverProfileId: profile.serverProfileId ?? "",
        userId: bundle.userId,
        deviceId: uuidToBytes(device.id ?? ""),
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + validityMs,
        accountMasterKey,
        recipientDeviceId: target.id,
        recipientEncryptionPublicKey: recipientPublicKey,
        signingPrivateKey,
      });
      const staged = await stageAccountKeyTransfer(
        actor,
        globalThis.crypto.randomUUID(),
        transfer,
        {
          recipientDeviceId: target.id,
          expiresAt: new Date(Date.now() + validityMs).toISOString(),
        },
      );
      onStaged({
        transferId: staged.transferId,
        expiresAt: staged.expiresAt,
        recipientDeviceId: staged.recipientDeviceId,
      });
      feedback.setMessage(
        "The transfer is staged. The receiving device redeems it from its own Recovery area, or on the CLI with `dotrelay device recover --transfer <id>`.",
      );
    } catch (error) {
      feedback.setError(
        recoveryErrorMessage(error, "The transfer wasn't sent. Try again."),
      );
    } finally {
      feedback.setBusy(false);
      onMutated();
    }
  })();
};

export type UnlockMethodOffer = Readonly<{
  readonly id: AccountRecoveryUnlockMethod;
  readonly label: string;
  readonly available: boolean;
  readonly note: string | undefined;
}>;

// The unlock methods, in display order. A method is offered only when
// the account actually has it (except "transfer", which always can):
// surfacing a method whose wrapper doesn't exist would only end in the
// uniform failure.
export const unlockMethods = (
  wrappers: readonly AccountKeyWrapperEntry[],
  passkeyAvailable: boolean,
): readonly UnlockMethodOffer[] => [
  {
    id: "recovery-code" as const,
    label: "Recovery code",
    available: wrappers.some((wrapper) => wrapper.type === "recovery-code"),
    note: undefined,
  },
  {
    id: "password" as const,
    label: "Encryption password",
    available: wrappers.some((wrapper) => wrapper.type === "password"),
    note: undefined,
  },
  {
    id: "passkey-prf" as const,
    label: "Passkey",
    available:
      passkeyAvailable &&
      wrappers.some((wrapper) => wrapper.type === "passkey-prf"),
    note: !passkeyAvailable ? "PRF not supported in this browser" : undefined,
  },
  {
    id: "transfer" as const,
    label: "From another device",
    available: true,
    note: undefined,
  },
];
