import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import {
  assertPublicationAccepted,
  type CliDeviceStorage,
  createCliDeviceStorage,
  createDeviceBootstrap,
  createDeviceCertificate,
  createDeviceEnrollmentApproval,
  createDeviceEnrollmentRequest,
  createDevicePrivateBundle,
  createProjectEpochGrantBootstrap,
  createProtocolTransport,
  createPublicationArtifacts,
  createRecoveryChallengeProof,
  createRecoveryKit,
  createVerifiedEnvironmentSession,
  type DecodedVariable,
  type DeviceEnrollmentRequest,
  type DeviceKeyMaterial,
  type DevicePrivateBundle,
  exportSigningPublicKey,
  loadDeviceKeyMaterial,
  openRecoveryKit,
  type ProtocolTransport,
  type PublicationContext,
  parseDeviceEnrollmentTranscript,
  reviewPublication,
  type SyncPageWire,
  verifySignedProtocolObject,
} from "@dotrelay/client";
import {
  encodeProtocolObject,
  exportEncryptionPrivateKey,
  exportSigningPrivateKey,
  importEncryptionPublicKey,
  importSigningPublicKey,
  parseProtocolObject,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  categoryForProblem,
  createEnvironment,
  createStrictJsonClient,
  type StrictJsonClient,
} from "./admin";
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
import { classifyVariablesInteractively } from "./classify-ui";
import { CliError, CliInvocationError } from "./errors";
import { assertSafeStdout, atomicWriteProtectedFile } from "./output";
import type { CliServerProfile, FetchFunction } from "./profile";
import { readTerminalLine, type TerminalIo } from "./terminal";

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
  readonly terminal?: TerminalIo;
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
  try {
    return await readTerminalLine(question, options.terminal);
  } catch {
    throw new CliInvocationError(`${question} requires interactive input`);
  }
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
  const recipientKey = await rawPublicKey(keys.encryptionPublicKey);
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
      categoryForProblem(code),
      "Device enrollment was rejected",
      {},
      code,
    );
  }
};

type AuthorizedDevice = Readonly<{
  readonly admin: StrictJsonClient;
  readonly boundary: Boundary;
  readonly userId: string;
  readonly deviceId: string;
  readonly bundle: DevicePrivateBundle;
  readonly keys: DeviceKeyMaterial;
}>;

type EnrollmentArtifact = Readonly<{
  readonly version: 1;
  readonly kind: "dotrelay-device-enrollment-request";
  readonly serverProfileId: string;
  readonly userId: string;
  readonly initiatorDeviceId: string;
  readonly enrollmentId: string;
  readonly deviceId: string;
  readonly identityGeneration: number;
  readonly operationId: string;
  readonly enrollmentObjectId: string;
  readonly expiresAt: string;
  readonly transcript: string;
  readonly transcriptHash: string;
  readonly initiatorSigningPublicKey: string;
  readonly certificate: string;
  readonly certificateObjectId: string;
}>;

type RecoveryArtifact = Readonly<{
  readonly version: 1;
  readonly kind: "dotrelay-recovery-kit";
  readonly serverProfileId: string;
  readonly userId: string;
  readonly envelopeId: string;
  readonly identityGeneration: number;
  readonly recoveryGeneration: number;
  readonly activeDeviceSigningPublicKey: string;
  readonly kit: string;
}>;

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const fromBase64 = (value: unknown, label: string): Uint8Array => {
  if (typeof value !== "string" || value.length === 0)
    throw new CliError(
      "crypto",
      `the ${label} is missing`,
      {},
      "artifact_invalid",
    );
  try {
    const bytes = new Uint8Array(Buffer.from(value, "base64"));
    if (bytes.length === 0) throw new Error("empty");
    return bytes;
  } catch {
    throw new CliError(
      "crypto",
      `the ${label} is invalid`,
      {},
      "artifact_invalid",
    );
  }
};

const artifactObject = async (
  path: string,
): Promise<Record<string, unknown>> => {
  try {
    const source = await readFile(path);
    if (source.byteLength > 8 * 1024 * 1024)
      throw new CliError(
        "local-io",
        "the Device handoff file is too large",
        {},
        "artifact_too_large",
      );
    const value: unknown = JSON.parse(new TextDecoder().decode(source));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "local-io",
      "could not read the Device handoff file",
      {},
      "artifact_read_failed",
    );
  }
};

const requiredArtifactString = (
  value: Record<string, unknown>,
  field: string,
): string => requiredString(value[field], `handoff ${field}`);

const readEnrollmentArtifact = async (
  path: string,
): Promise<EnrollmentArtifact> => {
  const value = await artifactObject(path);
  if (
    value.version !== 1 ||
    value.kind !== "dotrelay-device-enrollment-request"
  )
    throw new CliError(
      "crypto",
      "the enrollment handoff file has an unsupported format",
      {},
      "artifact_invalid",
    );
  const identityGeneration = value.identityGeneration;
  if (
    typeof identityGeneration !== "number" ||
    !Number.isSafeInteger(identityGeneration) ||
    identityGeneration < 0
  )
    throw new CliError(
      "crypto",
      "the enrollment handoff has an invalid identity generation",
      {},
      "artifact_invalid",
    );
  return Object.freeze({
    version: 1,
    kind: "dotrelay-device-enrollment-request",
    serverProfileId: requiredArtifactString(value, "serverProfileId"),
    userId: requiredArtifactString(value, "userId"),
    initiatorDeviceId: requiredArtifactString(value, "initiatorDeviceId"),
    enrollmentId: requiredArtifactString(value, "enrollmentId"),
    deviceId: requiredArtifactString(value, "deviceId"),
    identityGeneration,
    operationId: requiredArtifactString(value, "operationId"),
    enrollmentObjectId: requiredArtifactString(value, "enrollmentObjectId"),
    expiresAt: requiredArtifactString(value, "expiresAt"),
    transcript: requiredArtifactString(value, "transcript"),
    transcriptHash: requiredArtifactString(value, "transcriptHash"),
    initiatorSigningPublicKey: requiredArtifactString(
      value,
      "initiatorSigningPublicKey",
    ),
    certificate: requiredArtifactString(value, "certificate"),
    certificateObjectId: requiredArtifactString(value, "certificateObjectId"),
  });
};

const readRecoveryArtifact = async (
  path: string,
): Promise<RecoveryArtifact> => {
  const value = await artifactObject(path);
  if (value.version !== 1 || value.kind !== "dotrelay-recovery-kit")
    throw new CliError(
      "crypto",
      "the Recovery Kit has an unsupported format",
      {},
      "recovery_kit_invalid",
    );
  const identityGeneration = value.identityGeneration;
  const recoveryGeneration = value.recoveryGeneration;
  if (
    typeof identityGeneration !== "number" ||
    !Number.isSafeInteger(identityGeneration) ||
    identityGeneration < 0 ||
    typeof recoveryGeneration !== "number" ||
    !Number.isSafeInteger(recoveryGeneration) ||
    recoveryGeneration < 1
  )
    throw new CliError(
      "crypto",
      "the Recovery Kit generations are invalid",
      {},
      "recovery_kit_invalid",
    );
  return Object.freeze({
    version: 1,
    kind: "dotrelay-recovery-kit",
    serverProfileId: requiredArtifactString(value, "serverProfileId"),
    userId: requiredArtifactString(value, "userId"),
    envelopeId: requiredArtifactString(value, "envelopeId"),
    identityGeneration,
    recoveryGeneration,
    activeDeviceSigningPublicKey: requiredArtifactString(
      value,
      "activeDeviceSigningPublicKey",
    ),
    kit: requiredArtifactString(value, "kit"),
  });
};

const rawPublicKey = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key));

const createDeviceAdmin = (
  options: WorkflowOptions,
  deviceId?: string,
): StrictJsonClient =>
  options.admin ??
  createStrictJsonClient(options.profile.pin, options.credentials, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(deviceId ? { deviceId } : {}),
  });

const loadAuthorizedDevice = async (
  options: WorkflowOptions,
): Promise<AuthorizedDevice> => {
  const knownDeviceId =
    options.deviceId ??
    (await readDeviceId(
      deviceMetadataPath(options.stateDirectory, options.profile.pin),
    ));
  const firstAdmin = createDeviceAdmin(options, knownDeviceId ?? undefined);
  const session = await firstAdmin.get("/api/v1/session", [
    "authenticated",
    "user",
  ]);
  if (!isRecord(session.user))
    throw new CliError(
      "authentication",
      "the Server Profile returned no User identity",
      {},
      "session_invalid",
    );
  const userId = requiredString(session.user.id, "User id");
  const boundary = parseBoundary(
    await firstAdmin.get("/api/v1/workspace/boundary", [
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
  if (!boundary.device.active)
    throw new CliError(
      "authentication",
      "an active Device is required",
      {},
      "device_not_active",
    );
  const deviceId = options.deviceId ?? boundary.device.id ?? knownDeviceId;
  if (!deviceId)
    throw new CliError(
      "authentication",
      "the active Device is not available locally",
      {},
      "device_bundle_missing",
    );
  if (boundary.device.id && boundary.device.id !== deviceId)
    throw new CliError(
      "authentication",
      "the requested Device is not active",
      {},
      "device_not_active",
    );
  const storage = resolveDeviceStorage(options);
  let bundle: DevicePrivateBundle;
  try {
    bundle = await storage.load({
      pin: options.profile.pin,
      deviceId: uuidToBytes(deviceId),
    });
  } catch {
    throw new CliError(
      "authentication",
      "the active Device bundle is not available locally",
      {},
      "device_bundle_missing",
    );
  }
  let keys: DeviceKeyMaterial;
  try {
    keys = await loadDeviceKeyMaterial(bundle);
  } catch {
    throw new CliError(
      "crypto",
      "the active Device bundle is invalid",
      {},
      "device_bundle_invalid",
    );
  }
  return Object.freeze({
    admin: createDeviceAdmin(options, deviceId),
    boundary,
    userId,
    deviceId,
    bundle,
    keys,
  });
};

export const enrollDevice = async (
  options: WorkflowOptions,
  output?: string,
): Promise<
  Readonly<{
    deviceId: string;
    active: boolean;
    enrollmentId?: string;
    request?: string;
  }>
> => {
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
  if (boundary.device.active) return beginDeviceEnrollment(options, output);
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

const enrollmentStatePath = (directory: string, enrollmentId: string): string =>
  `${directory}/enrollment-${enrollmentId}.json`;

const enrollmentArtifactFromRequest = (
  request: DeviceEnrollmentRequest,
  operationId: string,
  enrollmentObjectId: string,
  certificateObjectId: string,
): EnrollmentArtifact => ({
  version: 1,
  kind: "dotrelay-device-enrollment-request",
  serverProfileId: request.ids.serverProfileId,
  userId: request.ids.userId,
  initiatorDeviceId: request.ids.initiatorDeviceId,
  enrollmentId: request.ids.enrollmentId,
  deviceId: request.ids.deviceId,
  identityGeneration: request.bundle.userIdentityGeneration,
  operationId,
  enrollmentObjectId,
  expiresAt: new Date(request.expiresAtMs).toISOString(),
  transcript: base64(request.transcriptBytes),
  transcriptHash: sha384ToHex(request.transcriptHash),
  initiatorSigningPublicKey: base64(request.initiatorSigningPublicKey),
  certificate: base64(request.certificateBytes),
  certificateObjectId,
});

const writeEnrollmentArtifact = async (
  options: WorkflowOptions,
  artifact: EnrollmentArtifact,
  output?: string,
): Promise<string> => {
  const statePathForEnrollment = enrollmentStatePath(
    options.stateDirectory,
    artifact.enrollmentId,
  );
  const contents = `${JSON.stringify(artifact)}\n`;
  await atomicWriteProtectedFile(statePathForEnrollment, contents);
  if (output && output !== statePathForEnrollment)
    await atomicWriteProtectedFile(output, contents);
  return output ?? statePathForEnrollment;
};

const requestForApproval = async (
  artifact: EnrollmentArtifact,
): Promise<
  Readonly<{ artifact: EnrollmentArtifact; request: DeviceEnrollmentRequest }>
> => {
  const transcriptBytes = fromBase64(
    artifact.transcript,
    "enrollment transcript",
  );
  const initiatorSigningPublicKey = fromBase64(
    artifact.initiatorSigningPublicKey,
    "initiator signing public key",
  );
  const transcript = await parseDeviceEnrollmentTranscript(
    transcriptBytes,
    initiatorSigningPublicKey,
  );
  if (
    transcript.serverProfileId !== artifact.serverProfileId.toLowerCase() ||
    transcript.userId !== artifact.userId.toLowerCase() ||
    transcript.enrollmentId !== artifact.enrollmentId.toLowerCase() ||
    transcript.deviceId !== artifact.deviceId.toLowerCase()
  )
    throw new CliError(
      "crypto",
      "the enrollment handoff is bound to a different identity",
      {},
      "enrollment_binding_mismatch",
    );
  const transcriptHash = await sha384(transcriptBytes);
  if (sha384ToHex(transcriptHash) !== artifact.transcriptHash.toLowerCase())
    throw new CliError(
      "crypto",
      "the enrollment handoff transcript hash is invalid",
      {},
      "enrollment_binding_mismatch",
    );
  return {
    artifact,
    request: {
      ids: {
        serverProfileId: transcript.serverProfileId,
        userId: transcript.userId,
        enrollmentId: transcript.enrollmentId,
        deviceId: transcript.deviceId,
        initiatorDeviceId: artifact.initiatorDeviceId,
      },
      challenge: transcript.challenge,
      expiresAtMs: transcript.expiresAtMs,
      transcriptBytes,
      transcriptHash,
      bundle: undefined as never,
      keyMaterial: undefined as never,
      initiatorSigningPublicKey,
      certificateBytes: fromBase64(artifact.certificate, "Device certificate"),
    } as DeviceEnrollmentRequest,
  };
};

export const beginDeviceEnrollment = async (
  options: WorkflowOptions,
  output?: string,
): Promise<
  Readonly<{
    enrollmentId: string;
    deviceId: string;
    active: boolean;
    request: string;
  }>
> => {
  const authorized = await loadAuthorizedDevice(options);
  if (!authorized.keys.signingPublicKey)
    throw new CliError(
      "crypto",
      "the active Device has no signing public key",
      {},
      "device_bundle_invalid",
    );
  const expiresAtMs = Date.now() + 10 * 60 * 1000;
  const request = await createDeviceEnrollmentRequest({
    serverProfileId: options.profile.pin.serverProfileId,
    origin: options.profile.origin,
    userId: authorized.userId,
    identityGeneration: authorized.bundle.userIdentityGeneration,
    initiatorDeviceId: authorized.deviceId,
    initiatorSigningPrivateKey: authorized.keys.signingPrivateKey,
    initiatorSigningPublicKey: await exportSigningPublicKey(
      authorized.keys.signingPublicKey,
    ),
    expiresAtMs,
  });
  const operationId = crypto.randomUUID();
  const certificateObjectId = crypto.randomUUID();
  const enrollmentObjectId = crypto.randomUUID();
  const artifact = enrollmentArtifactFromRequest(
    request,
    operationId,
    enrollmentObjectId,
    certificateObjectId,
  );
  const completeArtifact = Object.freeze({
    ...artifact,
  });
  const storage = resolveDeviceStorage(options);
  await storage.save(request.bundle);
  const response = await authorized.admin.post(
    "/api/v1/devices/enrollments",
    {
      operationId,
      enrollmentId: request.ids.enrollmentId,
      userId: authorized.userId,
      transcriptHash: sha384ToHex(request.transcriptHash),
      challengeHash: sha384ToHex(await sha384(request.challenge)),
      expiresAt: artifact.expiresAt,
    },
    ["enrollmentId", "expiresAt", "idempotent"],
    { idempotencyKey: operationId },
  );
  if (
    response.enrollmentId !== undefined &&
    requiredString(response.enrollmentId, "enrollment id") !==
      request.ids.enrollmentId
  )
    throw new CliError(
      "crypto",
      "the Server Profile returned the wrong enrollment id",
      {},
      "response_invalid",
    );
  const requestPath = await writeEnrollmentArtifact(
    options,
    completeArtifact,
    output,
  );
  return {
    enrollmentId: request.ids.enrollmentId,
    deviceId: request.ids.deviceId,
    active: false,
    request: requestPath,
  };
};

export const approveDeviceEnrollment = async (
  options: WorkflowOptions,
  path: string,
): Promise<
  Readonly<{ enrollmentId: string; deviceId: string; approved: boolean }>
> => {
  const artifact = await readEnrollmentArtifact(path);
  if (
    artifact.serverProfileId.toLowerCase() !==
    options.profile.pin.serverProfileId
  )
    throw new CliError(
      "authentication",
      "the enrollment handoff belongs to another Server Profile",
      {},
      "profile_mismatch",
    );
  const authorized = await loadAuthorizedDevice(options);
  if (artifact.userId.toLowerCase() !== authorized.userId.toLowerCase())
    throw new CliError(
      "authentication",
      "the enrollment handoff belongs to another User",
      {},
      "user_mismatch",
    );
  const parsed = await requestForApproval(artifact).catch((error) => {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "crypto",
      "the enrollment handoff could not be verified",
      {},
      "enrollment_binding_mismatch",
    );
  });
  const approval = await createDeviceEnrollmentApproval({
    request: parsed.request,
    approverDeviceId: authorized.deviceId,
    approverSigningPrivateKey: authorized.keys.signingPrivateKey,
  });
  const operationId = crypto.randomUUID();
  await authorized.admin.post(
    `/api/v1/devices/enrollments/${encodeURIComponent(artifact.enrollmentId)}/approve`,
    {
      operationId,
      enrolledDeviceId: artifact.deviceId,
      objectId: crypto.randomUUID(),
      object: base64(approval.canonicalBytes),
    },
    ["approved", "idempotent"],
    { idempotencyKey: operationId },
  );
  return {
    enrollmentId: artifact.enrollmentId,
    deviceId: artifact.deviceId,
    approved: true,
  };
};

export const completeDeviceEnrollment = async (
  options: WorkflowOptions,
  path: string,
): Promise<
  Readonly<{ enrollmentId: string; deviceId: string; active: boolean }>
> => {
  const artifact = await readEnrollmentArtifact(path);
  if (
    artifact.serverProfileId.toLowerCase() !==
    options.profile.pin.serverProfileId
  )
    throw new CliError(
      "authentication",
      "the enrollment handoff belongs to another Server Profile",
      {},
      "profile_mismatch",
    );
  const authorized = await loadAuthorizedDevice(options);
  if (
    artifact.userId.toLowerCase() !== authorized.userId.toLowerCase() ||
    artifact.initiatorDeviceId.toLowerCase() !==
      authorized.deviceId.toLowerCase()
  )
    throw new CliError(
      "authentication",
      "this Device cannot complete the enrollment handoff",
      {},
      "device_mismatch",
    );
  const transcript = await parseDeviceEnrollmentTranscript(
    fromBase64(artifact.transcript, "enrollment transcript"),
    fromBase64(
      artifact.initiatorSigningPublicKey,
      "initiator signing public key",
    ),
  );
  if (
    transcript.enrollmentId !== artifact.enrollmentId.toLowerCase() ||
    transcript.deviceId !== artifact.deviceId.toLowerCase()
  )
    throw new CliError(
      "crypto",
      "the enrollment handoff is invalid",
      {},
      "enrollment_binding_mismatch",
    );
  const certificateBytes = fromBase64(
    artifact.certificate,
    "Device certificate",
  );
  const certificate = parseProtocolObject(certificateBytes);
  if (
    certificate.get(1) !== 2 ||
    certificate.get(28) !== artifact.identityGeneration
  )
    throw new CliError(
      "crypto",
      "the enrollment certificate is invalid",
      {},
      "enrollment_certificate_invalid",
    );
  const storage = resolveDeviceStorage(options);
  const bundle = await storage.load({
    pin: options.profile.pin,
    deviceId: uuidToBytes(artifact.deviceId),
  });
  const keys = await loadDeviceKeyMaterial(bundle);
  if (!keys.encryptionPublicKey || !keys.signingPublicKey)
    throw new CliError(
      "crypto",
      "the pending Device bundle has no public key material",
      {},
      "device_bundle_invalid",
    );
  const x25519PublicKey = await rawPublicKey(keys.encryptionPublicKey);
  const ed25519PublicKey = await rawPublicKey(keys.signingPublicKey);
  const profileBytes = uuidToBytes(options.profile.pin.serverProfileId);
  const userBytes = uuidToBytes(authorized.userId);
  const deviceBytes = uuidToBytes(artifact.deviceId);
  const certificateProfile = certificate.get(8);
  const certificateUser = certificate.get(9);
  const certificateDevice = certificate.get(10);
  const certificateEncryptionKey = certificate.get(39);
  const certificateSigningKey = certificate.get(41);
  if (
    !(certificateProfile instanceof Uint8Array) ||
    !(certificateUser instanceof Uint8Array) ||
    !(certificateDevice instanceof Uint8Array) ||
    !(certificateEncryptionKey instanceof Uint8Array) ||
    !(certificateSigningKey instanceof Uint8Array) ||
    bytesToHex(certificateProfile) !== bytesToHex(profileBytes) ||
    bytesToHex(certificateUser) !== bytesToHex(userBytes) ||
    bytesToHex(certificateDevice) !== bytesToHex(deviceBytes) ||
    bytesToHex(certificateEncryptionKey) !== bytesToHex(x25519PublicKey) ||
    bytesToHex(certificateSigningKey) !== bytesToHex(ed25519PublicKey)
  )
    throw new CliError(
      "crypto",
      "the enrollment certificate does not match the pending Device",
      {},
      "enrollment_certificate_invalid",
    );
  try {
    await verifySignedProtocolObject(
      certificateBytes,
      await exportSigningPublicKey(keys.signingPublicKey),
    );
  } catch {
    throw new CliError(
      "crypto",
      "the enrollment certificate signature is invalid",
      {},
      "enrollment_certificate_invalid",
    );
  }
  const operationId = crypto.randomUUID();
  await authorized.admin.post(
    `/api/v1/devices/enrollments/${encodeURIComponent(artifact.enrollmentId)}/complete`,
    {
      operationId,
      enrollmentObjectId: artifact.enrollmentObjectId,
      enrollmentObject: base64(
        fromBase64(artifact.transcript, "enrollment transcript"),
      ),
      certificateObjectId: artifact.certificateObjectId,
      certificateObject: base64(certificateBytes),
      deviceId: artifact.deviceId,
      identityGeneration: String(artifact.identityGeneration),
      x25519PublicKey: base64(x25519PublicKey),
      ed25519PublicKey: base64(ed25519PublicKey),
      keyId: base64(await sha384(x25519PublicKey)),
    },
    ["deviceId", "active", "idempotent"],
    { idempotencyKey: operationId },
  );
  await writeDeviceId(
    deviceMetadataPath(options.stateDirectory, options.profile.pin),
    options.profile.pin,
    artifact.deviceId,
  );
  await unlink(
    enrollmentStatePath(options.stateDirectory, artifact.enrollmentId),
  ).catch(() => undefined);
  return {
    enrollmentId: artifact.enrollmentId,
    deviceId: artifact.deviceId,
    active: true,
  };
};

const protocolBytes = (
  object: ReadonlyMap<number, unknown>,
  field: number,
  label: string,
  length?: number,
): Uint8Array => {
  const value = object.get(field);
  if (
    !(value instanceof Uint8Array) ||
    (length !== undefined && value.length !== length)
  )
    throw new CliError(
      "crypto",
      `the ${label} is invalid`,
      {},
      "recovery_kit_invalid",
    );
  return value;
};

const protocolNumber = (
  object: ReadonlyMap<number, unknown>,
  field: number,
  label: string,
): number => {
  const value = object.get(field);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new CliError(
      "crypto",
      `the ${label} is invalid`,
      {},
      "recovery_kit_invalid",
    );
  return value;
};

const nextRecoveryGeneration = async (
  admin: StrictJsonClient,
): Promise<number> => {
  let current: Record<string, unknown>;
  try {
    current = await admin.get("/api/v1/recovery/envelopes/current", [
      "envelopeId",
      "identityGeneration",
      "recoveryGeneration",
      "ciphertextHash",
      "ciphertextLength",
      "object",
    ]);
  } catch (error) {
    if (error instanceof CliError && error.code === "resource_not_found")
      return 2;
    throw error;
  }
  const generation = current.recoveryGeneration;
  const parsed =
    typeof generation === "string" && /^[1-9][0-9]*$/.test(generation)
      ? BigInt(generation)
      : null;
  if (parsed === null || parsed >= BigInt(Number.MAX_SAFE_INTEGER))
    throw new CliError(
      "conflict",
      "the Recovery Kit generation cannot advance safely",
      {},
      "recovery_generation_invalid",
    );
  return Number(parsed + 1n);
};

export const createRecoveryBackup = async (
  options: WorkflowOptions,
  output: string,
): Promise<
  Readonly<{ output: string; envelopeId: string; recoveryGeneration: number }>
> => {
  const authorized = await loadAuthorizedDevice(options);
  const recoveryGeneration = await nextRecoveryGeneration(authorized.admin);
  const kit = await createRecoveryKit({
    serverProfileId: options.profile.pin.serverProfileId,
    userId: authorized.userId,
    identityGeneration: authorized.bundle.userIdentityGeneration,
    recoveryGeneration,
    activeDeviceSigningPrivateKey: authorized.keys.signingPrivateKey,
  });
  const envelope = parseProtocolObject(kit.envelopeBytes);
  const envelopeId = kit.envelopeId;
  const artifact: RecoveryArtifact = {
    version: 1,
    kind: "dotrelay-recovery-kit",
    serverProfileId: options.profile.pin.serverProfileId,
    userId: authorized.userId,
    envelopeId,
    identityGeneration: kit.identityGeneration,
    recoveryGeneration: kit.recoveryGeneration,
    activeDeviceSigningPublicKey: base64(
      await exportSigningPublicKey(
        authorized.keys.signingPublicKey ??
          (() => {
            throw new CliError(
              "crypto",
              "the active Device has no signing public key",
              {},
              "device_bundle_invalid",
            );
          })(),
      ),
    ),
    kit: base64(kit.bytes),
  };
  const priorArtifactPath = `${output}.previous`;
  try {
    const priorArtifact = await readFile(output);
    await atomicWriteProtectedFile(
      priorArtifactPath,
      new TextDecoder().decode(priorArtifact),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteProtectedFile(output, `${JSON.stringify(artifact)}\n`);
  const operationId = crypto.randomUUID();
  await authorized.admin.post(
    "/api/v1/recovery/envelopes",
    {
      operationId,
      objectId: envelopeId,
      object: base64(kit.envelopeBytes),
      envelopeId,
      identityGeneration: String(kit.identityGeneration),
      recoveryGeneration: String(kit.recoveryGeneration),
      ciphertextHash: sha384ToHex(
        protocolBytes(envelope, 48, "Recovery Kit ciphertext hash", 48),
      ),
      ciphertextLength: protocolNumber(
        envelope,
        72,
        "Recovery Kit ciphertext length",
      ),
    },
    ["envelopeId", "recoveryGeneration", "idempotent"],
    { idempotencyKey: operationId },
  );
  return { output, envelopeId, recoveryGeneration };
};

const publicSpkiFromPrivate = async (
  privateKey: CryptoKey,
  exportPrivate: (key: CryptoKey) => Promise<Uint8Array>,
): Promise<Uint8Array> => {
  try {
    const privateKeyObject = createPrivateKey({
      key: Buffer.from(await exportPrivate(privateKey)),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKeyObject).export({
      format: "der",
      type: "spki",
    });
    return new Uint8Array(publicKey as Buffer);
  } catch {
    throw new CliError(
      "crypto",
      "the Recovery Kit replacement keys are invalid",
      {},
      "recovery_kit_invalid",
    );
  }
};

const loadRecoveryIdentity = async (
  options: WorkflowOptions,
): Promise<
  Readonly<{ admin: StrictJsonClient; boundary: Boundary; userId: string }>
> => {
  const admin = createDeviceAdmin(options);
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
      "Recovery Kit restore requires no active Device",
      {},
      "recovery_requires_no_active_device",
    );
  return { admin, boundary, userId };
};

export const restoreRecoveryKit = async (
  options: WorkflowOptions,
  path: string,
): Promise<
  Readonly<{ deviceId: string; active: boolean; recoveryGeneration: number }>
> => {
  const artifact = await readRecoveryArtifact(path);
  if (
    artifact.serverProfileId.toLowerCase() !==
    options.profile.pin.serverProfileId
  )
    throw new CliError(
      "authentication",
      "the Recovery Kit belongs to another Server Profile",
      {},
      "profile_mismatch",
    );
  const identity = await loadRecoveryIdentity(options);
  if (artifact.userId.toLowerCase() !== identity.userId.toLowerCase())
    throw new CliError(
      "authentication",
      "the Recovery Kit belongs to another User",
      {},
      "user_mismatch",
    );
  let opened: Awaited<ReturnType<typeof openRecoveryKit>>;
  try {
    opened = await openRecoveryKit(fromBase64(artifact.kit, "Recovery Kit"), {
      serverProfileId: options.profile.pin.serverProfileId,
      userId: identity.userId,
      activeDeviceSigningPublicKey: fromBase64(
        artifact.activeDeviceSigningPublicKey,
        "Recovery Kit signing public key",
      ),
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "crypto",
      "the Recovery Kit could not be verified",
      {},
      "recovery_kit_invalid",
    );
  }
  if (
    opened.envelopeId !== artifact.envelopeId.toLowerCase() ||
    opened.identityGeneration !== artifact.identityGeneration ||
    opened.recoveryGeneration !== artifact.recoveryGeneration
  )
    throw new CliError(
      "crypto",
      "the Recovery Kit metadata does not match its envelope",
      {},
      "recovery_kit_invalid",
    );
  const encryptionSpki = await publicSpkiFromPrivate(
    opened.replacementEncryptionPrivateKey,
    exportEncryptionPrivateKey,
  );
  const signingSpki = await publicSpkiFromPrivate(
    opened.replacementSigningPrivateKey,
    exportSigningPrivateKey,
  );
  const encryptionPublicKey = await importEncryptionPublicKey(encryptionSpki);
  const signingPublicKey = await importSigningPublicKey(signingSpki);
  const bundle = await createDevicePrivateBundle({
    pin: options.profile.pin,
    userId: uuidToBytes(identity.userId),
    deviceId: uuidToBytes(opened.replacementDeviceId),
    userIdentityGeneration: opened.identityGeneration,
    keyMaterial: {
      encryptionPrivateKey: opened.replacementEncryptionPrivateKey,
      signingPrivateKey: opened.replacementSigningPrivateKey,
      encryptionPublicKey,
      signingPublicKey,
    },
    encryptionPublicKey: encryptionSpki,
    signingPublicKey: signingSpki,
  });
  const rawEncryptionPublicKey = await rawPublicKey(encryptionPublicKey);
  const rawSigningPublicKey = await rawPublicKey(signingPublicKey);
  const storage = resolveDeviceStorage(options);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const challengeExpiresAtMs = Date.now() + 10 * 60 * 1000;
  const proof = await createRecoveryChallengeProof({
    serverProfileId: options.profile.pin.serverProfileId,
    userId: identity.userId,
    replacementDeviceId: opened.replacementDeviceId,
    correlationId: opened.envelopeId,
    identityGeneration: opened.identityGeneration,
    recoveryGeneration: opened.recoveryGeneration,
    challenge,
    expiresAtMs: challengeExpiresAtMs,
    signingPrivateKey: opened.replacementSigningPrivateKey,
  });
  const certificate = await createDeviceCertificate({
    serverProfileId: options.profile.pin.serverProfileId,
    userId: identity.userId,
    deviceId: opened.replacementDeviceId,
    identityGeneration: opened.identityGeneration,
    encryptionPublicKey: rawEncryptionPublicKey,
    signingPublicKey: rawSigningPublicKey,
    signingPrivateKey: opened.replacementSigningPrivateKey,
  });
  const operationId = crypto.randomUUID();
  await storage.save(bundle);
  await writeDeviceId(
    deviceMetadataPath(options.stateDirectory, options.profile.pin),
    options.profile.pin,
    opened.replacementDeviceId,
  );
  await identity.admin.post(
    "/api/v1/recovery/restore",
    {
      operationId,
      objectId: opened.envelopeId,
      envelope: base64(encodeProtocolObject(opened.envelope)),
      object: base64(encodeProtocolObject(opened.envelope)),
      envelopeId: opened.envelopeId,
      identityGeneration: String(opened.identityGeneration),
      recoveryGeneration: String(opened.recoveryGeneration),
      deviceId: opened.replacementDeviceId,
      challenge: base64(challenge),
      expiresAt: new Date(challengeExpiresAtMs).toISOString(),
      proof: base64(proof.canonicalBytes),
      replacementEncryptionPublicKey: base64(rawEncryptionPublicKey),
      replacementSigningPublicKey: base64(rawSigningPublicKey),
      x25519PublicKey: base64(rawEncryptionPublicKey),
      ed25519PublicKey: base64(rawSigningPublicKey),
      keyId: base64(await sha384(rawEncryptionPublicKey)),
      certificateId: crypto.randomUUID(),
      certificate: base64(certificate),
    },
    ["deviceId", "active", "recoveryGeneration", "idempotent"],
    { idempotencyKey: operationId },
  );
  return {
    deviceId: opened.replacementDeviceId,
    active: true,
    recoveryGeneration: opened.recoveryGeneration,
  };
};

const opaqueEnvironmentId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const resolveRequestedEnvironmentId = (
  parsed: ParsedArguments,
  localContext: Readonly<{ readonly environmentId?: string }> | null,
): string | undefined => {
  const positional =
    parsed.command === "init" ? parsed.positionals[0] : undefined;
  if (positional) {
    if (!opaqueEnvironmentId.test(positional))
      throw new CliInvocationError(
        "init environment must be an opaque Environment id",
      );
    return positional.toLowerCase();
  }
  if (parsed.environment) return parsed.environment;
  return localContext?.environmentId;
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
  const { readWorktreeContext, writeWorktreeContext } = await import(
    "./context"
  );
  const localContext = await readWorktreeContext(options.contextPath);
  const requestedEnvironment = resolveRequestedEnvironmentId(
    parsed,
    localContext,
  );
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
  if (!selectedEnvironment) {
    if (parsed.command !== "init")
      throw new CliInvocationError("an Environment must be selected");
    const created = await createEnvironment(
      admin,
      boundary.environment.projectId,
    );
    selectedEnvironment = created.id;
    await writeWorktreeContext(options.contextPath, {
      serverProfileId: options.profile.pin.serverProfileId,
      projectId: boundary.environment.projectId,
      environmentId: created.id,
    });
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
  const provided = Object.fromEntries(
    Object.entries(parsed.classifications).map(([name, classification]) => [
      name,
      classification,
    ]),
  ) as Readonly<Partial<Record<string, "shared" | "user-defined">>>;
  const missing = entries.filter((entry) => !(entry.name in provided));
  if (missing.length === 0)
    return classifyDotenv(
      entries,
      Object.fromEntries(
        Object.entries(provided).map(([name, classification]) => [
          name,
          { classification: classification! },
        ]),
      ),
    );
  if (options.noInput)
    throw new CliInvocationError(
      "every Variable requires --classify NAME=shared|user-defined under --no-input",
    );
  const selected = await classifyVariablesInteractively(
    entries.map((entry) => entry.name),
    provided,
    {
      ...(options.terminal ? { terminal: options.terminal } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    },
  );
  return classifyDotenv(
    entries,
    Object.fromEntries(
      Object.entries(selected).map(([name, classification]) => [
        name,
        { classification },
      ]),
    ),
  );
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
  const liveVariableCount = variables.filter(
    (variable) => !variable.tombstone,
  ).length;
  if (
    !options.noInput &&
    !(await confirm(
      options,
      `Publish ${liveVariableCount} Variables?`,
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
        : `the Server Profile could not publish the Revision (${code})`,
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
    const inputPath = parsed.from ?? ".env";
    let source: string;
    try {
      source = await readFile(inputPath, "utf8");
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
