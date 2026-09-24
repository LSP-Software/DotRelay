import {
  authenticatedCreatorKeys,
  createAccountKeyEnvelope,
  createProtocolTransport,
  createVerifiedEnvironmentSession,
  type DecodedVariable,
  deviceHistorySigningKeys,
  exportSigningPublicKey,
  openAccountKeyEnvelope,
  openOwnedUserValueKey,
  openProjectEpochGrant,
  type PublicationContext,
  parseAccountKeyEnvelope,
  type SyncPageWire,
  UnreadableLaneError,
  USER_VALUE_KEY_GENERATION,
} from "@dotrelay/client";
import {
  encodeProtocolObject,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";
import { createEnvironment, resolveEnvironmentReference } from "./admin";
import type { ParsedArguments } from "./args";
import { createSessionStore } from "./auth";
import { note } from "./components";
import { deviceMetadataPath, readDeviceId } from "./device-storage";
import { CliError, CliInvocationError } from "./errors";
import { loadAccountMasterKey } from "./workflow-account-key";
import {
  accountKeyTrustedKeys,
  adminClient,
  base64,
  bytesToHex,
  collectSigningTrust,
  createDeviceAdmin,
  fromBase64,
  opaqueEnvironmentId,
  parseBoundary,
  readTrustedHead,
  resolveRequestedEnvironmentReference,
  safeProjectEpoch,
  statePath,
  verifyDeviceBundle,
  type WorkflowOptions,
  type WorkflowSession,
  workspaceBoundaryFields,
  writeTrustedHead,
  zeros,
} from "./workflow-core";
import {
  bootstrapProjectGrant,
  wrapEpochKeyToPeers,
} from "./workflow-epoch-grants";

// id instead of creating another Environment to publish into. Each CLI process
// builds a fresh options object per run, so object identity tracks the
// invocation; in-process callers that reuse one options object across runs
// (test harnesses) share the memo, which is the intended behaviour.
const createdEnvironmentByInvocation = new WeakMap<object, string>();

export const loadWorkflowSession = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<WorkflowSession> => {
  const knownDeviceId =
    options.deviceId ??
    (await readDeviceId(
      deviceMetadataPath(options.stateDirectory, options.profile.pin),
    ));
  const admin = knownDeviceId
    ? createDeviceAdmin(options, knownDeviceId)
    : adminClient(options);
  const { readWorktreeContext } = await import("./context");
  const localContext = await readWorktreeContext(options.contextPath);
  let requestedEnvironment =
    options.environmentId ??
    resolveRequestedEnvironmentReference(parsed, localContext);
  if (
    requestedEnvironment !== undefined &&
    !opaqueEnvironmentId.test(requestedEnvironment)
  ) {
    const projectId = localContext?.projectId;
    if (projectId === undefined) {
      // Project link and environment resolution both need a signed-in
      // Device, so a missing session is reported before a missing link.
      const token = await createSessionStore(options.credentials).get(
        options.profile.pin,
      );
      if (!token)
        throw new CliError(
          "authentication",
          "login is required for this Server Profile",
          {},
          "authentication_required",
        );
      throw new CliInvocationError(
        "the Environment reference could not be resolved to a stable id; run dotrelay project link to record the Project",
      );
    }
    requestedEnvironment = (
      await resolveEnvironmentReference(
        admin,
        projectId,
        requestedEnvironment,
        {
          noInput: options.noInput,
          ...(options.prompt ? { prompt: options.prompt } : {}),
          ...(options.terminal ? { terminal: options.terminal } : {}),
        },
      )
    ).id;
  }
  const boundary = parseBoundary(
    await admin.get(
      `/api/v1/workspace/boundary${requestedEnvironment ? `?environment=${encodeURIComponent(requestedEnvironment)}` : ""}`,
      workspaceBoundaryFields,
    ),
  );
  if (!boundary.session.active || !boundary.session.userId)
    throw new CliError(
      "authentication",
      "login is required for this Server Profile",
      {},
      "authentication_required",
    );
  if (!boundary.device.active)
    throw knownDeviceId
      ? new CliError(
          "authentication",
          "the local Device is not active on this Server Profile; run dotrelay device enroll or dotrelay device recover",
          {},
          "device_not_active",
        )
      : new CliError(
          "authentication",
          "no Device is enrolled on this installation; run dotrelay login or dotrelay device enroll",
          {},
          "device_bundle_missing",
        );
  if (!knownDeviceId)
    throw new CliError(
      "authentication",
      "no Device is enrolled on this installation; run dotrelay login or dotrelay device enroll",
      {},
      "device_bundle_missing",
    );
  const deviceId = knownDeviceId;
  const {
    bundle,
    keys,
    encryptionPublicKey: deviceEncryptionPublicKey,
    signingPublicKey: deviceSigningPublicKey,
  } = await verifyDeviceBundle(
    options,
    boundary,
    deviceId,
    "the local Device is not active on this Server Profile; run dotrelay device enroll or dotrelay device recover",
  );
  if (!boundary.cryptoAvailable)
    throw new CliError(
      "crypto",
      "the closed v3 cryptographic suite is unavailable",
      {},
      "crypto_provider_unavailable",
    );
  if (!boundary.epochCurrent)
    throw new CliError(
      "conflict",
      "the Project epoch is stale",
      {},
      "stale_epoch",
    );
  if (boundary.rotationRequired)
    throw new CliError(
      "conflict",
      "required key rotation must complete before publishing",
      {},
      "rotation_required",
    );
  if (
    !boundary.environment.projectId ||
    !boundary.environment.teamId ||
    !boundary.environment.projectEpoch
  )
    throw new CliError(
      "conflict",
      "the selected Environment has no active Project context",
      {},
      "environment_context_missing",
    );
  let selectedEnvironment =
    requestedEnvironment ?? boundary.environment.id ?? undefined;
  let createdEnvironmentId: string | undefined;
  if (!selectedEnvironment) {
    if (parsed.command !== "init")
      throw new CliInvocationError("an Environment must be selected");
    const earlier = createdEnvironmentByInvocation.get(options);
    if (earlier !== undefined) {
      // A previous phase of this invocation already created the Environment.
      createdEnvironmentId = earlier;
      selectedEnvironment = earlier;
    } else {
      createdEnvironmentId = (
        await createEnvironment(admin, boundary.environment.projectId)
      ).id;
      createdEnvironmentByInvocation.set(options, createdEnvironmentId);
      selectedEnvironment = createdEnvironmentId;
    }
  }
  const token = await createSessionStore(options.credentials).get(
    options.profile.pin,
  );
  if (!token)
    throw new CliError(
      "authentication",
      "login is required for this Server Profile",
      {},
      "authentication_required",
    );
  // A Device that holds the Account Master Key opens the Project Epoch Key
  // from the Account Key Envelope the service holds, so it reads
  // pre-existing content without any peer. A peer that already holds the
  // current epoch grant owns the real key in the meantime: self-minting a
  // fresh random key can never decrypt pre-existing content and blocks the
  // peer re-share, so the key must come from a Device that holds it.
  const pendingActions: string[] = [];
  const peerHoldsEpochKey = boundary.peerDevices.some(
    (peer) => peer.hasEpochGrant,
  );
  let accountMasterKey: Uint8Array | null = null;
  try {
    accountMasterKey = await loadAccountMasterKey(options, deviceId);
  } catch {
    accountMasterKey = null;
  }
  let epochKey: Uint8Array | undefined;
  if (
    accountMasterKey !== null &&
    boundary.accountKeyEnvelope !== undefined &&
    boundary.environment.projectId !== null
  ) {
    let envelope: ReturnType<typeof parseAccountKeyEnvelope> | null = null;
    try {
      envelope = parseAccountKeyEnvelope(
        fromBase64(boundary.accountKeyEnvelope, "Account key envelope"),
      );
    } catch {
      envelope = null;
    }
    if (
      envelope !== null &&
      envelope.projectId !== undefined &&
      bytesToHex(envelope.projectId) ===
        bytesToHex(uuidToBytes(boundary.environment.projectId)) &&
      envelope.projectEpoch ===
        safeProjectEpoch(boundary.environment.projectEpoch)
    ) {
      try {
        const localSigningKey = await exportSigningPublicKey(
          deviceSigningPublicKey,
        );
        epochKey = await openAccountKeyEnvelope(envelope, accountMasterKey, {
          trustedKeys: accountKeyTrustedKeys(boundary, localSigningKey),
          context: {
            serverProfileId: uuidToBytes(options.profile.pin.serverProfileId),
            userId: bundle.userId,
            // The envelope's deviceId/userIdentityGeneration are the creator
            // Device's (signature-authenticated); do not pin them to the opener.
            envelopeType: envelope.envelopeType,
            projectId: envelope.projectId,
            projectEpoch: envelope.projectEpoch,
          },
        });
      } catch {
        epochKey = undefined;
      }
    }
  }
  if (
    epochKey === undefined &&
    accountMasterKey !== null &&
    !boundary.grantsReady &&
    !peerHoldsEpochKey &&
    boundary.environment.projectId !== null
  ) {
    // No Device holds this epoch's key, so this unlocked Device establishes
    // it: a fresh random Project Epoch Key wrapped by the User's AMK.
    const userId = boundary.session.userId;
    if (userId === undefined)
      throw new CliError(
        "transient",
        "the Server Profile returned no User identity",
        {},
        "session_invalid",
      );
    const projectEpoch = safeProjectEpoch(boundary.environment.projectEpoch);
    epochKey = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await createAccountKeyEnvelope({
      serverProfileId: options.profile.pin.serverProfileId,
      userId: uuidToBytes(userId),
      deviceId: uuidToBytes(deviceId),
      createdAtMs: Date.now(),
      accountMasterKey,
      signingPrivateKey: keys.signingPrivateKey,
      kind: {
        type: "projectEpochKey",
        projectId: uuidToBytes(boundary.environment.projectId),
        projectEpoch,
        contentKey: epochKey,
      },
    });
    const operationId = crypto.randomUUID();
    try {
      await createDeviceAdmin(options, deviceId).post(
        "/api/v1/account-keys/envelopes",
        {
          operationId,
          objectId: crypto.randomUUID(),
          object: base64(encodeProtocolObject(envelope.object)),
          projectId: boundary.environment.projectId,
          projectEpoch: String(projectEpoch),
          ciphertextHash: sha384ToHex(await sha384(envelope.ciphertext)),
          ciphertextLength: envelope.ciphertext.length,
        },
        ["objectId", "idempotent"],
        { idempotencyKey: operationId },
      );
    } catch (error) {
      if (error instanceof CliError && error.code === "state_conflict")
        throw new CliError(
          "conflict",
          "this project epoch already has an account key envelope; refresh and open the existing key instead of creating another",
          {},
          "account_key_envelope_conflict",
        );
      throw error;
    }
  } else if (epochKey === undefined && boundary.epochGrant) {
    epochKey = await openProjectEpochGrant(
      fromBase64(boundary.epochGrant, "Project epoch grant"),
      keys.encryptionPrivateKey,
    );
  } else if (
    epochKey === undefined &&
    accountMasterKey === null &&
    !boundary.grantsReady &&
    !peerHoldsEpochKey
  ) {
    epochKey = await bootstrapProjectGrant(
      options,
      token,
      boundary,
      deviceId,
      keys,
    );
  } else if (epochKey === undefined && !boundary.grantsReady) {
    pendingActions.push(
      "This Device is missing the Project epoch grant; an owner or admin can provision it by running dotrelay pull from their own Device",
    );
  }
  // A locked Device's missing Account Master Key is surfaced by the device
  // backup/recover commands, not here: the missing-grant action above already
  // names the actionable fix when the epoch key is unavailable, and an empty
  // Environment needs no key at all.
  if (epochKey) {
    for (const action of await wrapEpochKeyToPeers(
      options,
      token,
      boundary,
      deviceId,
      keys,
      epochKey,
    ))
      pendingActions.push(action);
  }
  if (pendingActions.length > 0 && !parsed.json) {
    const output = options.terminal?.output ?? process.stderr;
    for (const action of pendingActions)
      output.write(`${note(action, "warn")}\n`);
  }
  const transport = createProtocolTransport({
    origin: options.profile.origin,
    authorization: `Bearer ${token}`,
    ...(options.fetch ? { fetch: options.fetch as never } : {}),
  });
  const signingPublicKey = await exportSigningPublicKey(deviceSigningPublicKey);
  const signingTrustKeys = collectSigningTrust(boundary, signingPublicKey);
  let userValueKey: Uint8Array | undefined;
  if (accountMasterKey !== null && boundary.session.userId) {
    const unlockedKey = accountMasterKey;
    const ownerUserId = uuidToBytes(boundary.session.userId);
    const trustedKeys = accountKeyTrustedKeys(boundary, signingPublicKey);
    const verification = {
      trustedKeys,
      context: {
        serverProfileId: uuidToBytes(options.profile.pin.serverProfileId),
        userId: ownerUserId,
      },
      ownerUserId,
    };
    const openEnvelope = async (
      object: string,
      claimedCreatorKey?: string,
    ): Promise<Uint8Array | null> => {
      const extras = authenticatedCreatorKeys(
        claimedCreatorKey ? [claimedCreatorKey] : [],
        deviceHistorySigningKeys(boundary),
      );
      return openOwnedUserValueKey(
        fromBase64(object, "User value key envelope"),
        unlockedKey,
        extras.length === 0
          ? verification
          : {
              ...verification,
              trustedKeys: accountKeyTrustedKeys(
                boundary,
                signingPublicKey,
                extras,
              ),
            },
      );
    };
    try {
      if (boundary.userValueKeyEnvelope) {
        const opened = await openEnvelope(boundary.userValueKeyEnvelope);
        if (opened) userValueKey = opened;
      }
      if (!userValueKey) {
        const contentKey = crypto.getRandomValues(new Uint8Array(32));
        const envelope = await createAccountKeyEnvelope({
          serverProfileId: options.profile.pin.serverProfileId,
          userId: ownerUserId,
          deviceId: uuidToBytes(deviceId),
          createdAtMs: Date.now(),
          accountMasterKey: unlockedKey,
          signingPrivateKey: keys.signingPrivateKey,
          kind: {
            type: "userValueKey",
            ownerUserId,
            valueGeneration: USER_VALUE_KEY_GENERATION,
            contentKey,
          },
        });
        const operationId = crypto.randomUUID();
        try {
          await createDeviceAdmin(options, deviceId).post(
            "/api/v1/account-keys/envelopes",
            {
              operationId,
              objectId: crypto.randomUUID(),
              object: base64(encodeProtocolObject(envelope.object)),
              ownerUserId: boundary.session.userId,
              valueGeneration: String(USER_VALUE_KEY_GENERATION),
              ciphertextHash: sha384ToHex(await sha384(envelope.ciphertext)),
              ciphertextLength: envelope.ciphertext.length,
            },
            ["objectId", "idempotent"],
            { idempotencyKey: operationId },
          );
          userValueKey = contentKey;
        } catch (error) {
          if (!(error instanceof CliError) || error.code !== "state_conflict")
            throw error;
          const listed = await createDeviceAdmin(options, deviceId).get(
            "/api/v1/account-keys/envelopes",
            ["envelopes"],
          );
          const envelopes = listed.envelopes;
          if (Array.isArray(envelopes)) {
            for (const entry of envelopes) {
              if (
                !entry ||
                typeof entry !== "object" ||
                !("object" in entry) ||
                typeof entry.object !== "string" ||
                entry.envelopeType !== "user-value-key" ||
                entry.valueGeneration !== String(USER_VALUE_KEY_GENERATION)
              )
                continue;
              const claimed =
                "creatorPublicKey" in entry &&
                typeof entry.creatorPublicKey === "string"
                  ? entry.creatorPublicKey
                  : undefined;
              const opened = claimed
                ? await openEnvelope(entry.object, claimed)
                : await openEnvelope(entry.object);
              if (opened) {
                userValueKey = opened;
                break;
              }
            }
          }
        }
      }
    } catch {
      userValueKey = undefined;
    }
  }
  const publicationContext: PublicationContext = {
    serverProfileId: options.profile.pin.serverProfileId,
    teamId: boundary.environment.teamId,
    projectId: boundary.environment.projectId,
    environmentId: selectedEnvironment,
    actorUserId: boundary.session.userId,
    actorDeviceId: deviceId,
    projectEpoch: safeProjectEpoch(boundary.environment.projectEpoch),
    expectedHeadId: null,
    expectedHeadHash: null,
    valueRecipientPublicKey: deviceEncryptionPublicKey,
    userDefinedValueRecipientPublicKey: deviceEncryptionPublicKey,
    signingPrivateKey: keys.signingPrivateKey,
    revisionSigningPublicKey: signingPublicKey,
    ...(epochKey ? { sharedValueSecret: epochKey } : {}),
    ...(userValueKey ? { userDefinedValueSecret: userValueKey } : {}),
  };
  const session = createVerifiedEnvironmentSession({
    context: publicationContext,
    transport,
    sharedValuePrivateKey: keys.encryptionPrivateKey,
    userDefinedValuePrivateKey: keys.encryptionPrivateKey,
    signingTrustKeys,
    ...(epochKey ? { sharedValueSecret: epochKey } : {}),
    ...(userValueKey ? { userDefinedValueSecret: userValueKey } : {}),
  });
  return {
    boundary,
    bundle,
    keys,
    deviceId,
    transport,
    publicationContext,
    session,
    pendingActions,
    ...(createdEnvironmentId ? { createdEnvironmentId } : {}),
  };
};

export const syncWorkflow = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<
  Readonly<{
    workflow: WorkflowSession;
    page: SyncPageWire;
    variables: readonly DecodedVariable[];
  }>
> => {
  const workflow = await loadWorkflowSession(options, parsed);
  const environmentId = workflow.publicationContext.environmentId;
  // The local head file records the last verified result, but the CLI does not
  // persist decrypted manifests. Replaying the chain from the stable genesis
  // anchor gives every invocation the prior Variables it needs without
  // creating a plaintext cache.
  const trustedRevisionId = environmentId;
  const trustedRevisionHash = zeros(48);
  let synced: Awaited<ReturnType<typeof workflow.session.syncAndDecode>>;
  try {
    synced = await workflow.session.syncAndDecode({
      environmentId,
      deviceId: workflow.deviceId,
      request: {
        trustedRevisionId,
        trustedRevisionHash,
        pagination: { ...(parsed.limit ? { limit: parsed.limit } : {}) },
      },
    });
  } catch (error) {
    if (!(error instanceof UnreadableLaneError)) throw error;
    // The verified history says the Manifest changed but this Device cannot
    // read it: failing here keeps the local file and the trusted head
    // untouched and names the grant that must be repaired.
    const detail =
      error.laneKind === "USER_DEFINED_VALUE"
        ? "the Environment's User-defined Values cannot be decrypted with this Device's key grant; run dotrelay device enroll or dotrelay device recover, then re-publish the affected Values"
        : "the Environment's Manifest cannot be decrypted with this Device's Project key grant; run dotrelay pull after an owner or admin re-shares it from their own Device";
    throw new CliError("incomplete-export", detail, {}, "unreadable_manifest");
  }
  const page = synced.page;
  const localHead = await readTrustedHead(
    statePath(options.stateDirectory, environmentId),
  );
  if (localHead) {
    const localHeadVerified = page.revisions.some(
      (revision) =>
        revision.id === localHead.id &&
        bytesToHex(revision.digest) === bytesToHex(localHead.hash),
    );
    const verifiedEmptyHead =
      localHead.id === environmentId &&
      localHead.hash.every((byte) => byte === 0) &&
      page.currentHeadId === null;
    if (!localHeadVerified && !verifiedEmptyHead)
      throw new CliError(
        "crypto",
        "the local trusted head does not match verified Environment history",
        {},
        "trusted_head_conflict",
      );
  }
  if (page.projectEpoch !== BigInt(safeProjectEpoch(page.projectEpoch)))
    throw new CliError(
      "transient",
      "the server returned an invalid Project epoch",
      {},
      "response_invalid",
    );
  if (page.currentHeadId && page.currentHeadHash)
    await writeTrustedHead(
      statePath(options.stateDirectory, environmentId),
      page.currentHeadId,
      page.currentHeadHash,
    );
  const variables = synced.variables;
  return { workflow, page, variables };
};
