import { readFile } from "node:fs/promises";
import {
  assertPublicationAccepted,
  type CliDeviceStorage,
  createCliDeviceStorage,
  createDeviceBootstrap,
  createProjectEpochGrantBootstrap,
  createProtocolTransport,
  createPublicationArtifacts,
  createVerifiedEnvironmentSession,
  type DecodedVariable,
  type DeviceKeyMaterial,
  type DevicePrivateBundle,
  exportEncryptionPublicKey,
  exportSigningPublicKey,
  loadDeviceKeyMaterial,
  type ProtocolTransport,
  type PublicationContext,
  reviewPublication,
  type SyncPageWire,
} from "@dotrelay/client";
import { sha384, sha384ToHex, uuidToBytes } from "@dotrelay/contracts";
import { createStrictJsonClient, type StrictJsonClient } from "./admin";
import type { ParsedArguments } from "./args";
import { createSessionStore } from "./auth";
import type { NativeCredentialStore } from "./credentials";
import {
  createFileDeviceRecordStore,
  deviceMetadataPath,
  readDeviceId,
  writeDeviceId,
} from "./device-storage";
import {
  type ClassifiedDotenvEntry,
  classifyDotenv,
  type DotenvEntry,
  parseDotenv,
  serializeDotenv,
} from "./dotenv";
import { CliError, CliInvocationError } from "./errors";
import { assertSafeStdout, atomicWriteProtectedFile } from "./output";
import type { CliServerProfile, FetchFunction } from "./profile";

export type WorkflowOptions = Readonly<{
  readonly profile: CliServerProfile;
  readonly credentials: NativeCredentialStore;
  readonly fetch?: FetchFunction;
  readonly deviceStorage?: CliDeviceStorage;
  readonly deviceId?: string;
  readonly stateDirectory: string;
  readonly contextPath: string;
  readonly prompt?: (question: string) => Promise<string>;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly noInput: boolean;
  readonly stdoutIsTerminal: boolean;
  readonly admin?: StrictJsonClient;
}>;

type Boundary = Readonly<{
  readonly environment: Readonly<{
    readonly id: string | null;
    readonly projectId: string | null;
    readonly teamId: string | null;
    readonly headRevision: string;
    readonly headHash: string | null;
    readonly projectEpoch: string | null;
  }>;
  readonly session: Readonly<{
    readonly active: boolean;
    readonly userId?: string;
  }>;
  readonly device: Readonly<{
    readonly active: boolean;
    readonly id?: string;
    readonly encryptionPublicKey?: string;
    readonly signingPublicKey?: string;
  }>;
  readonly grantsReady: boolean;
  readonly epochCurrent: boolean;
  readonly rotationRequired: boolean;
  readonly cryptoAvailable: boolean;
}>;

type WorkflowSession = Readonly<{
  readonly boundary: Boundary;
  readonly bundle: DevicePrivateBundle;
  readonly keys: DeviceKeyMaterial;
  readonly deviceId: string;
  readonly transport: ProtocolTransport;
  readonly publicationContext: PublicationContext;
  readonly session: ReturnType<typeof createVerifiedEnvironmentSession>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new CliError(
      "transient",
      `the server returned an invalid ${label}`,
      {},
      "response_invalid",
    );
  return value;
};

const parseBoundary = (value: Record<string, unknown>): Boundary => {
  const environment = value.environment;
  const session = value.session;
  const device = value.device;
  if (!isRecord(environment) || !isRecord(session) || !isRecord(device))
    throw new CliError(
      "transient",
      "the server returned an invalid workflow boundary",
      {},
      "response_invalid",
    );
  const optionalString = (candidate: unknown): string | null =>
    candidate === null || candidate === undefined
      ? null
      : requiredString(candidate, "workflow boundary field");
  return Object.freeze({
    environment: Object.freeze({
      id: optionalString(environment.id),
      projectId: optionalString(environment.projectId),
      teamId: optionalString(environment.teamId),
      headRevision: requiredString(
        environment.headRevision,
        "Environment head",
      ),
      headHash: optionalString(environment.headHash),
      projectEpoch: optionalString(environment.projectEpoch),
    }),
    session: Object.freeze({
      active: session.active === true,
      ...(typeof session.userId === "string" ? { userId: session.userId } : {}),
    }),
    device: Object.freeze({
      active: device.active === true,
      ...(typeof device.id === "string" ? { id: device.id } : {}),
      ...(typeof device.encryptionPublicKey === "string"
        ? { encryptionPublicKey: device.encryptionPublicKey }
        : {}),
      ...(typeof device.signingPublicKey === "string"
        ? { signingPublicKey: device.signingPublicKey }
        : {}),
    }),
    grantsReady: value.grantsReady === true,
    epochCurrent: value.epochCurrent === true,
    rotationRequired: value.rotationRequired === true,
    cryptoAvailable: isRecord(value.crypto) && value.crypto.available === true,
  });
};

const zeros = (length: number): Uint8Array => new Uint8Array(length);

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const statePath = (directory: string, environmentId: string): string =>
  `${directory}/head-${environmentId}.json`;

const readTrustedHead = async (
  path: string,
): Promise<Readonly<{ id: string; hash: Uint8Array }> | null> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof value.id !== "string" ||
      typeof value.hash !== "string" ||
      !/^[0-9a-f]{96}$/i.test(value.hash)
    )
      throw new CliError(
        "crypto",
        "the local trusted head record is invalid",
        {},
        "trusted_head_invalid",
      );
    try {
      uuidToBytes(value.id);
    } catch {
      throw new CliError(
        "crypto",
        "the local trusted head record is invalid",
        {},
        "trusted_head_invalid",
      );
    }
    const hash = new Uint8Array(48);
    for (let index = 0; index < hash.length; index += 1)
      hash[index] = Number.parseInt(
        value.hash.slice(index * 2, index * 2 + 2),
        16,
      );
    return Object.freeze({ id: value.id, hash });
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(
      "local-io",
      "could not read the local trusted head record",
      {},
      "trusted_head_read_failed",
    );
  }
};

const safeProjectEpoch = (value: unknown): number => {
  const epoch =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isInteger(value)
        ? BigInt(value)
        : typeof value === "string" && /^\d+$/.test(value)
          ? BigInt(value)
          : null;
  if (epoch === null || epoch < 1n || epoch > BigInt(Number.MAX_SAFE_INTEGER))
    throw new CliError(
      "transient",
      "the server returned an invalid Project epoch",
      {},
      "response_invalid",
    );
  return Number(epoch);
};

const writeTrustedHead = async (
  path: string,
  id: string,
  hash: Uint8Array,
): Promise<void> => {
  await atomicWriteProtectedFile(
    path,
    `${JSON.stringify({ id, hash: sha384ToHex(hash) })}\n`,
  );
};

const ask = async (
  options: WorkflowOptions,
  question: string,
): Promise<string> => {
  if (options.prompt) return options.prompt(question);
  if (options.noInput)
    throw new CliInvocationError(`${question} requires interactive input`);
  const prompt = (
    globalThis as unknown as { prompt?: (value: string) => string | null }
  ).prompt;
  const answer = prompt?.(question);
  if (typeof answer !== "string")
    throw new CliInvocationError(`${question} requires interactive input`);
  return answer;
};

const confirm = async (
  options: WorkflowOptions,
  question: string,
): Promise<boolean> => {
  if (options.confirm) return options.confirm(question);
  const answer = await ask(options, `${question} [y/N]`);
  return (
    answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes"
  );
};

const resolveDeviceStorage = (options: WorkflowOptions): CliDeviceStorage =>
  options.deviceStorage ??
  createCliDeviceStorage(options.profile.pin, options.credentials, {
    recordStore: createFileDeviceRecordStore(options.stateDirectory),
  });

const responseJson = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  try {
    const value = await response.json();
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new CliError(
      "transient",
      "the Server Profile returned invalid JSON",
      {},
      "response_invalid",
    );
  }
};

const bootstrapProjectGrant = async (
  options: WorkflowOptions,
  token: string,
  boundary: Boundary,
  deviceId: string,
  keys: DeviceKeyMaterial,
): Promise<void> => {
  if (!boundary.environment.projectId || !boundary.environment.teamId)
    throw new CliError(
      "conflict",
      "the selected Environment has no Project epoch context",
      {},
      "environment_context_missing",
    );
  if (!keys.encryptionPublicKey)
    throw new CliError(
      "crypto",
      "the Device encryption key is unavailable",
      {},
      "device_bundle_invalid",
    );
  const recipientKey = await exportEncryptionPublicKey(
    keys.encryptionPublicKey,
  );
  const grant = await createProjectEpochGrantBootstrap({
    serverProfileId: options.profile.pin.serverProfileId,
    teamId: boundary.environment.teamId,
    projectId: boundary.environment.projectId,
    projectEpoch: safeProjectEpoch(boundary.environment.projectEpoch),
    senderDeviceId: deviceId,
    recipientDeviceId: deviceId,
    recipientX25519PublicKey: recipientKey,
    recipientEncryptionPublicKey: keys.encryptionPublicKey,
    signingPrivateKey: keys.signingPrivateKey,
  });
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${options.profile.origin}/api/v1/grants/bootstrap`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-DotRelay-Device-Id": deviceId,
        },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          teamId: boundary.environment.teamId,
          projectId: boundary.environment.projectId,
          objectId: grant.objectId,
          digest: Buffer.from(await sha384(grant.canonicalBytes)).toString(
            "base64",
          ),
          grant: Buffer.from(grant.canonicalBytes).toString("base64"),
        }),
      },
    );
  } catch {
    throw new CliError(
      "transient",
      "could not reach the Project grant endpoint",
      {},
      "grant_bootstrap_unavailable",
    );
  }
  if (!response.ok) {
    const body = await responseJson(response).catch(() => undefined);
    const code =
      typeof body?.code === "string" ? body.code : "grant_bootstrap_failed";
    throw new CliError(
      ["stale_epoch", "operation_conflict", "state_conflict"].includes(code)
        ? "conflict"
        : code === "invalid_crypto_object"
          ? "crypto"
          : "authentication",
      "Project epoch grant bootstrap was rejected",
      {},
      code,
    );
  }
};

const postBootstrap = async (
  options: WorkflowOptions,
  token: string,
  input: Readonly<{
    readonly operationId: string;
    readonly deviceId: string;
    readonly certificateId: string;
    readonly identityGeneration: number;
    readonly x25519PublicKey: Uint8Array;
    readonly ed25519PublicKey: Uint8Array;
    readonly keyId: Uint8Array;
    readonly certificate: Uint8Array;
  }>,
): Promise<void> => {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${options.profile.origin}/api/v1/devices/bootstrap`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          operationId: input.operationId,
          deviceId: input.deviceId,
          certificateId: input.certificateId,
          identityGeneration: input.identityGeneration,
          x25519PublicKey: bytesToHex(input.x25519PublicKey),
          ed25519PublicKey: [...input.ed25519PublicKey]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
          keyId: sha384ToHex(input.keyId),
          certificate: Buffer.from(input.certificate).toString("base64"),
        }),
      },
    );
  } catch {
    throw new CliError(
      "transient",
      "could not reach the Device enrollment endpoint",
      {},
      "device_enrollment_unavailable",
    );
  }
  if (!response.ok) {
    const body = await responseJson(response).catch(() => undefined);
    const code =
      typeof body?.code === "string" ? body.code : "device_enrollment_failed";
    throw new CliError(
      code === "authentication_required" ? "authentication" : "conflict",
      "Device enrollment was rejected",
      {},
      code,
    );
  }
};

export const enrollDevice = async (
  options: WorkflowOptions,
): Promise<Readonly<{ deviceId: string; active: boolean }>> => {
  const sessions = createSessionStore(options.credentials);
  const token = await sessions.get(options.profile.pin);
  if (!token)
    throw new CliError(
      "authentication",
      "login is required before Device enrollment",
      {},
      "authentication_required",
    );
  const admin =
    options.admin ??
    createStrictJsonClient(options.profile.pin, options.credentials, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  const session = await admin.get("/api/v1/session", ["authenticated", "user"]);
  if (!isRecord(session.user))
    throw new CliError(
      "authentication",
      "the Server Profile returned no User identity",
      {},
      "session_invalid",
    );
  const userId = requiredString(session.user.id, "User id");
  const boundary = parseBoundary(
    await admin.get("/api/v1/workspace/boundary", [
      "environment",
      "session",
      "profile",
      "device",
      "grantsReady",
      "epochCurrent",
      "rotationRequired",
      "crypto",
      "projectEpoch",
    ]),
  );
  if (boundary.device.active)
    throw new CliError(
      "conflict",
      "an active Device already exists; dual-control enrollment is required",
      {},
      "device_enrollment_requires_approval",
    );
  const bootstrap = await createDeviceBootstrap({
    pin: options.profile.pin,
    userId,
  });
  await postBootstrap(options, token, {
    operationId: crypto.randomUUID(),
    deviceId: bootstrap.deviceId,
    certificateId: bootstrap.certificate.id,
    identityGeneration: bootstrap.identityGeneration,
    x25519PublicKey: bootstrap.x25519PublicKey,
    ed25519PublicKey: bootstrap.ed25519PublicKey,
    keyId: bootstrap.keyId,
    certificate: bootstrap.certificate.canonicalBytes,
  });
  const storage = resolveDeviceStorage(options);
  await storage.save(bootstrap.bundle);
  await writeDeviceId(
    deviceMetadataPath(options.stateDirectory, options.profile.pin),
    options.profile.pin,
    bootstrap.deviceId,
  );
  return { deviceId: bootstrap.deviceId, active: true };
};

const loadWorkflowSession = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<WorkflowSession> => {
  const admin =
    options.admin ??
    createStrictJsonClient(options.profile.pin, options.credentials, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  const { readWorktreeContext } = await import("./context");
  const localContext = await readWorktreeContext(options.contextPath);
  const requestedEnvironment =
    (parsed.command === "init" ? parsed.positionals[0] : undefined) ??
    parsed.environment ??
    localContext?.environmentId;
  const boundary = parseBoundary(
    await admin.get(
      `/api/v1/workspace/boundary${requestedEnvironment ? `?environment=${encodeURIComponent(requestedEnvironment)}` : ""}`,
      [
        "environment",
        "session",
        "profile",
        "device",
        "grantsReady",
        "epochCurrent",
        "rotationRequired",
        "crypto",
        "projectEpoch",
      ],
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
    throw new CliError(
      "authentication",
      "an active Device is required",
      {},
      "device_not_active",
    );
  const deviceId =
    options.deviceId ??
    boundary.device.id ??
    (await readDeviceId(
      deviceMetadataPath(options.stateDirectory, options.profile.pin),
    ));
  if (!deviceId)
    throw new CliError(
      "authentication",
      "the active Device is not available locally",
      {},
      "device_bundle_missing",
    );
  const storage = resolveDeviceStorage(options);
  const bundle = await storage.load({
    pin: options.profile.pin,
    deviceId: uuidToBytes(deviceId),
  });
  const keys = await loadDeviceKeyMaterial(bundle);
  if (!keys.encryptionPublicKey || !keys.signingPublicKey)
    throw new CliError(
      "crypto",
      "the Device bundle has no public key material",
      {},
      "device_bundle_invalid",
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
  const environmentId = requestedEnvironment;
  const selectedEnvironment = environmentId ?? boundary.environment.id;
  if (!selectedEnvironment)
    throw new CliInvocationError("an Environment must be selected");
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
  if (!boundary.grantsReady) {
    await bootstrapProjectGrant(options, token, boundary, deviceId, keys);
  }
  const transport = createProtocolTransport({
    origin: options.profile.origin,
    authorization: `Bearer ${token}`,
    ...(options.fetch ? { fetch: options.fetch as never } : {}),
  });
  const signingPublicKey = await exportSigningPublicKey(keys.signingPublicKey);
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
    valueRecipientPublicKey: keys.encryptionPublicKey,
    userDefinedValueRecipientPublicKey: keys.encryptionPublicKey,
    signingPrivateKey: keys.signingPrivateKey,
    revisionSigningPublicKey: signingPublicKey,
  };
  const session = createVerifiedEnvironmentSession({
    context: publicationContext,
    transport,
    sharedValuePrivateKey: keys.encryptionPrivateKey,
    userDefinedValuePrivateKey: keys.encryptionPrivateKey,
  });
  return {
    boundary,
    bundle,
    keys,
    deviceId,
    transport,
    publicationContext,
    session,
  };
};

const syncWorkflow = async (
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
  const synced = await workflow.session.syncAndDecode({
    environmentId,
    deviceId: workflow.deviceId,
    request: {
      trustedRevisionId,
      trustedRevisionHash,
      pagination: { ...(parsed.limit ? { limit: parsed.limit } : {}) },
    },
  });
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

const classify = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
  entries: readonly DotenvEntry[],
): Promise<readonly ClassifiedDotenvEntry[]> => {
  const classifications: Record<
    string,
    { classification: "shared" | "user-defined" }
  > = {};
  for (const entry of entries) {
    const value =
      parsed.classifications[entry.name] ??
      (
        await ask(options, `Classify ${entry.name} as shared or user-defined`)
      ).trim();
    if (value !== "shared" && value !== "user-defined")
      throw new CliInvocationError(
        `classification for ${entry.name} must be shared or user-defined`,
      );
    classifications[entry.name] = { classification: value };
  }
  return classifyDotenv(entries, classifications);
};

const variablesFromDotenv = (
  entries: readonly ClassifiedDotenvEntry[],
  existing: readonly DecodedVariable[],
): readonly DecodedVariable[] => {
  const used = new Set<string>();
  const variables = entries.map((entry) => {
    const prior = existing.find(
      (candidate) => candidate.name === entry.name && !candidate.tombstone,
    );
    if (
      prior &&
      prior.ownership !==
        (entry.classification === "shared"
          ? "SHARED_VALUE"
          : "USER_DEFINED_VALUE")
    )
      throw new CliInvocationError(
        `classification for ${entry.name} does not match the existing Variable`,
      );
    const variable = {
      id: prior?.id ?? crypto.randomUUID(),
      name: entry.name,
      description: prior?.description ?? "",
      ownership:
        entry.classification === "shared"
          ? ("SHARED_VALUE" as const)
          : ("USER_DEFINED_VALUE" as const),
      value: entry.value,
      required: prior?.required ?? true,
      tombstone: false,
    };
    used.add(variable.id);
    return Object.freeze(variable);
  });
  return Object.freeze([
    ...variables,
    ...existing
      .filter((variable) => !used.has(variable.id) && !variable.tombstone)
      .map((variable) =>
        Object.freeze({ ...variable, value: null, tombstone: true }),
      ),
  ]);
};

const toPublicationVariable = (
  variable: DecodedVariable,
  existing: readonly DecodedVariable[],
): Parameters<typeof createPublicationArtifacts>[0][number] => {
  const prior = existing.find((candidate) => candidate.id === variable.id);
  return {
    ...variable,
    hasDraftChange:
      !prior ||
      prior.name !== variable.name ||
      prior.description !== variable.description ||
      prior.ownership !== variable.ownership ||
      prior.value !== variable.value ||
      prior.required !== variable.required ||
      prior.tombstone !== variable.tombstone,
  };
};

const publish = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
  variables: readonly DecodedVariable[],
  mutation: "GENESIS" | "MANIFEST_UPDATE" | "ROLLBACK",
  rollback?: Readonly<{ target: string; ids: readonly string[] }>,
): Promise<Record<string, unknown>> => {
  const synced = await syncWorkflow(options, parsed);
  const context: PublicationContext = {
    ...synced.workflow.publicationContext,
    expectedHeadId: synced.page.currentHeadId,
    expectedHeadHash: synced.page.currentHeadHash,
    projectEpoch: safeProjectEpoch(synced.page.projectEpoch),
    mutation,
    ...(rollback
      ? {
          rollbackTargetId: rollback.target,
          rollbackSelectedVariableIds: rollback.ids,
        }
      : {}),
  };
  const artifacts = await createPublicationArtifacts(
    variables.map((variable) =>
      toPublicationVariable(variable, synced.variables),
    ),
    context,
  );
  const review = reviewPublication(artifacts.commandBytes);
  assertPublicationAccepted(review);
  if (
    !options.noInput &&
    !(await confirm(
      options,
      `Publish ${review.manifestVariables} Variables and ${review.manifestLaneCommitments} encrypted lanes?`,
    ))
  )
    throw new CliInvocationError("publication confirmation was declined");
  const operationId = crypto.randomUUID();
  try {
    await synced.workflow.transport.begin({
      operationId,
      deviceId: synced.workflow.deviceId,
      kind: mutation === "ROLLBACK" ? "ROLLBACK" : "REVISION_PUBLICATION",
      commandBytes: artifacts.commandBytes,
      commandDigest: await sha384(artifacts.commandBytes),
    });
    for (const staged of artifacts.stagedObjects)
      await synced.workflow.transport.stage({
        operationId,
        deviceId: synced.workflow.deviceId,
        objectId: staged.objectId,
        bytes: staged.bytes,
      });
    await synced.workflow.transport.finalize({
      operationId,
      deviceId: synced.workflow.deviceId,
      request: artifacts.request,
    });
  } catch (error) {
    await synced.workflow.transport
      .cancel({ operationId, deviceId: synced.workflow.deviceId })
      .catch(() => undefined);
    if (error instanceof CliError) throw error;
    const problem = error as { problem?: { code?: string } };
    const code = problem.problem?.code ?? "service_unavailable";
    const category = [
      "stale_head",
      "stale_epoch",
      "operation_conflict",
      "state_conflict",
    ].includes(code)
      ? "conflict"
      : [
            "invalid_crypto_object",
            "unsupported_media_type",
            "unsupported_crypto_suite",
          ].includes(code)
        ? "crypto"
        : "transient";
    throw new CliError(
      category,
      category === "conflict"
        ? "the publication conflicts with current Server Profile state"
        : "the Server Profile could not publish the Revision",
      {},
      code,
    );
  }
  return {
    revision: artifacts.request.revision.id,
    lanes: artifacts.encryptedLaneCount,
    tombstones: artifacts.tombstoneLaneCount,
  };
};

export const runProtectedWorkflow = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<Record<string, unknown> | { stdout: string }> => {
  if (parsed.command === "history") {
    const synced = await syncWorkflow(options, parsed);
    return {
      revisions: synced.page.revisions.map((revision) => ({
        id: revision.id,
        mutation: revision.mutation,
        projectEpoch: revision.projectEpoch.toString(),
        authoredAtMs: revision.authoredAtMs.toString(),
        rollbackTargetId: revision.rollbackTargetId,
      })),
    };
  }
  if (parsed.command === "pull") {
    if (!parsed.output && !parsed.stdout)
      throw new CliInvocationError("pull requires --output <file> or --stdout");
    const synced = await syncWorkflow(options, parsed);
    const missing = synced.variables.filter(
      (variable) => !variable.tombstone && variable.value === null,
    );
    if (missing.length > 0)
      throw new CliError(
        "incomplete-export",
        "the Environment has Values that are not available on this Device",
        { missingCount: missing.length },
        "missing_values",
      );
    const entries = synced.variables
      .filter((variable) => !variable.tombstone)
      .map((variable) => ({
        name: variable.name,
        value: variable.value ?? "",
      }));
    const contents = serializeDotenv(entries);
    if (
      parsed.stdout &&
      parsed.reveal &&
      !options.noInput &&
      !(await confirm(
        options,
        `Reveal ${entries.length} decrypted Values to stdout?`,
      ))
    )
      throw new CliInvocationError("Value reveal confirmation was declined");
    assertSafeStdout({
      requested: parsed.stdout,
      terminal: options.stdoutIsTerminal,
      reveal: parsed.reveal,
    });
    if (parsed.output) await atomicWriteProtectedFile(parsed.output, contents);
    return parsed.stdout
      ? { stdout: contents }
      : { output: parsed.output ?? "" };
  }
  if (parsed.command === "init" || parsed.command === "push") {
    if (!parsed.from)
      throw new CliInvocationError(`${parsed.command} requires --from <file>`);
    let source: string;
    try {
      source = await readFile(parsed.from, "utf8");
    } catch {
      throw new CliError(
        "local-io",
        "could not read the dotenv input file",
        {},
        "input_read_failed",
      );
    }
    const entries = await classify(options, parsed, parseDotenv(source));
    const synced = await syncWorkflow(options, parsed);
    const variables = variablesFromDotenv(
      entries,
      parsed.command === "init" ? [] : synced.variables,
    );
    if (parsed.command === "init" && synced.page.currentHeadId !== null)
      throw new CliError(
        "conflict",
        "the Environment already has a genesis Revision",
        {},
        "environment_not_empty",
      );
    return publish(
      options,
      parsed,
      variables,
      parsed.command === "init" ? "GENESIS" : "MANIFEST_UPDATE",
    );
  }
  if (parsed.command === "rollback") {
    const target = parsed.positionals[0];
    if (!target)
      throw new CliInvocationError("rollback requires a target Revision");
    try {
      uuidToBytes(target);
    } catch {
      throw new CliInvocationError("rollback requires a valid Revision id");
    }
    const synced = await syncWorkflow(options, parsed);
    const selected = new Set(parsed.variableIds);
    const current = synced.variables.filter((variable) => !variable.tombstone);
    if (
      parsed.variableIds.some(
        (id) => !current.some((variable) => variable.id === id),
      )
    )
      throw new CliInvocationError(
        "rollback Variable is not part of the live Manifest",
      );
    let targetValues: ReadonlyMap<string, string | null>;
    try {
      targetValues = await synced.workflow.session.resolveRollbackValues({
        targetRevision: target,
        selectedVariableIds: parsed.variableIds,
      });
    } catch {
      throw new CliError(
        "conflict",
        "the target Revision is not available in verified history",
        {},
        "rollback_target_unavailable",
      );
    }
    const variables = current.map((variable) =>
      selected.has(variable.id)
        ? Object.freeze({
            ...variable,
            value: targetValues.get(variable.id) ?? null,
          })
        : variable,
    );
    return publish(options, parsed, variables, "ROLLBACK", {
      target,
      ids: parsed.variableIds,
    });
  }
  throw new CliInvocationError(
    "the protected workflow is not available for this command",
  );
};
