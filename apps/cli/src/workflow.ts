import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  decodeSyncVariables,
  exportSigningPublicKey,
  loadDeviceKeyMaterial,
  openProjectEpochGrant,
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
  generateEncryptionKeyPair,
  importEncryptionPublicKey,
  importSigningPublicKey,
  parseProtocolObject,
  type ServerProfilePin,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  categoryForProblem,
  createEnvironment,
  createStrictJsonClient,
  listEnvironments,
  listTeams,
  type StrictJsonClient,
} from "./admin";
import type { ParsedArguments } from "./args";
import { createSessionStore } from "./auth";
import { classifyVariablesInteractively } from "./classify-ui";
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
  type DotenvDiffChange,
  type DotenvEntry,
  diffDotenvEntries,
  parseDotenv,
  serializeDotenv,
} from "./dotenv";
import { CliError, CliInvocationError, sanitizeCliText } from "./errors";
import {
  createGitTrackingProbe,
  ensureLocalGitExclusion,
  type GitTrackingProbe,
} from "./git-tracking";
import { assertSafeStdout, atomicWriteProtectedFile } from "./output";
import type { CliServerProfile, FetchFunction } from "./profile";
import { readTerminalLine, type TerminalIo } from "./terminal";
import { writeNotice } from "./ui";
import {
  type PublicationChange,
  type PublicationDestination,
  publicationConfirmQuestion,
  pullConfirmQuestion,
  renderDestinationLines,
  renderEnvDiff,
  type ValueOwnership,
  valueDiffsForPull,
} from "./value-diff";

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
  readonly force: boolean;
  readonly stdoutIsTerminal: boolean;
  readonly admin?: StrictJsonClient;
  readonly environmentId?: string;
  readonly gitTracking?: GitTrackingProbe;
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
  readonly activeDeviceCount: number;
  readonly rotationRequired: boolean;
  readonly cryptoAvailable: boolean;
  readonly epochGrant?: string;
  readonly signingTrustKeys: readonly string[];
  readonly peerDevices: readonly Readonly<{
    readonly id: string;
    readonly encryptionPublicKey: string;
    readonly signingPublicKey: string;
    readonly hasEpochGrant: boolean;
  }>[];
}>;

type WorkflowSession = Readonly<{
  readonly boundary: Boundary;
  readonly bundle: DevicePrivateBundle;
  readonly keys: DeviceKeyMaterial;
  readonly deviceId: string;
  readonly transport: ProtocolTransport;
  readonly publicationContext: PublicationContext;
  readonly session: ReturnType<typeof createVerifiedEnvironmentSession>;
  readonly createdEnvironmentId?: string;
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

const workspaceBoundaryFields = [
  "environment",
  "session",
  "profile",
  "device",
  "grantsReady",
  "epochCurrent",
  "activeDeviceCount",
  "rotationRequired",
  "crypto",
  "projectEpoch",
  "catalog",
  "signingTrustKeys",
  "epochGrant",
  "peerDevices",
] as const;

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
    activeDeviceCount:
      typeof value.activeDeviceCount === "number" &&
      Number.isSafeInteger(value.activeDeviceCount) &&
      value.activeDeviceCount >= 0
        ? value.activeDeviceCount
        : 0,
    rotationRequired: value.rotationRequired === true,
    cryptoAvailable: isRecord(value.crypto) && value.crypto.available === true,
    ...(typeof value.epochGrant === "string"
      ? { epochGrant: value.epochGrant }
      : {}),
    signingTrustKeys: Array.isArray(value.signingTrustKeys)
      ? value.signingTrustKeys.filter(
          (key): key is string => typeof key === "string",
        )
      : [],
    peerDevices: Array.isArray(value.peerDevices)
      ? value.peerDevices.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          if (
            typeof entry.id !== "string" ||
            typeof entry.encryptionPublicKey !== "string"
          )
            return [];
          return [
            {
              id: entry.id,
              encryptionPublicKey: entry.encryptionPublicKey,
              signingPublicKey:
                typeof entry.signingPublicKey === "string"
                  ? entry.signingPublicKey
                  : "",
              hasEpochGrant: entry.hasEpochGrant === true,
            },
          ];
        })
      : [],
  });
};

const zeros = (length: number): Uint8Array => new Uint8Array(length);

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hexToBytes = (value: string): Uint8Array => {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0)
    throw new CliError(
      "transient",
      "the server returned an invalid Device public key",
      {},
      "response_invalid",
    );
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

const collectSigningTrustKeys = (
  boundary: Boundary,
  localSigningPublicKey: Uint8Array,
): Uint8Array[] => {
  const keys = [localSigningPublicKey];
  const seen = new Set([bytesToHex(localSigningPublicKey)]);
  const addHex = (value: string): void => {
    try {
      const bytes = hexToBytes(value);
      const hex = bytesToHex(bytes);
      if (seen.has(hex)) return;
      seen.add(hex);
      keys.push(bytes);
    } catch {
      return;
    }
  };
  for (const key of boundary.signingTrustKeys) addHex(key);
  if (boundary.device.signingPublicKey)
    addHex(boundary.device.signingPublicKey);
  for (const peer of boundary.peerDevices)
    if (peer.signingPublicKey.length > 0) addHex(peer.signingPublicKey);
  return keys;
};

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
    throw new CliInvocationError(
      "this command requires interactive input; remove --no-input to answer the prompt",
    );
  try {
    return await readTerminalLine(question, options.terminal);
  } catch {
    // The question may carry revealed Values; only a fixed message may
    // surface through the diagnostic.
    throw new CliInvocationError(
      "the terminal could not be read, so the interactive prompt went unanswered",
    );
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
): Promise<Uint8Array> => {
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
  await submitEpochGrant(options, token, boundary, deviceId, grant);
  return grant.plaintextKey;
};

const wrapEpochKeyToPeers = async (
  options: WorkflowOptions,
  token: string,
  boundary: Boundary,
  deviceId: string,
  keys: DeviceKeyMaterial,
  epochKey: Uint8Array,
): Promise<void> => {
  if (
    !keys.encryptionPublicKey ||
    !boundary.environment.projectId ||
    !boundary.environment.teamId
  )
    return;
  for (const peer of boundary.peerDevices) {
    if (peer.id === deviceId) continue;
    const recipientX25519PublicKey = hexToBytes(peer.encryptionPublicKey);
    if (recipientX25519PublicKey.length !== 32) continue;
    const recipientEncryptionPublicKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(recipientX25519PublicKey),
      { name: "X25519" },
      true,
      [],
    );
    const grant = await createProjectEpochGrantBootstrap({
      serverProfileId: options.profile.pin.serverProfileId,
      teamId: boundary.environment.teamId ?? "",
      projectId: boundary.environment.projectId ?? "",
      projectEpoch: safeProjectEpoch(boundary.environment.projectEpoch),
      senderDeviceId: deviceId,
      recipientDeviceId: peer.id,
      recipientX25519PublicKey,
      recipientEncryptionPublicKey,
      signingPrivateKey: keys.signingPrivateKey,
      plaintextKey: epochKey,
    });
    await submitEpochGrant(options, token, boundary, deviceId, grant);
  }
};

const submitEpochGrant = async (
  options: WorkflowOptions,
  token: string,
  boundary: Boundary,
  deviceId: string,
  grant: Awaited<ReturnType<typeof createProjectEpochGrantBootstrap>>,
): Promise<void> => {
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

// Confirms that the boundary names this Device, loads the matching local
// bundle, and checks the bundle's keys against the keys the Server Profile
// has registered for the Device. A bundle that no longer matches the
// registered keys (for example after a recovery on another installation)
// must be treated as unusable rather than trusted.
const verifyDeviceBundle = async (
  options: WorkflowOptions,
  boundary: Boundary,
  deviceId: string,
  notActiveMessage: string,
): Promise<
  Readonly<{
    bundle: DevicePrivateBundle;
    keys: DeviceKeyMaterial;
    encryptionPublicKey: CryptoKey;
    signingPublicKey: CryptoKey;
  }>
> => {
  if (!boundary.device.active)
    throw new CliError(
      "authentication",
      notActiveMessage,
      {},
      "device_not_active",
    );
  if (boundary.device.id !== deviceId)
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
  const encryptionPublicKey = keys.encryptionPublicKey;
  const signingPublicKey = keys.signingPublicKey;
  if (!encryptionPublicKey || !signingPublicKey)
    throw new CliError(
      "crypto",
      "the Device bundle has no public key material",
      {},
      "device_bundle_invalid",
    );
  const registeredKeys: Array<readonly [registered: string, local: CryptoKey]> =
    [];
  if (boundary.device.encryptionPublicKey !== undefined)
    registeredKeys.push([
      boundary.device.encryptionPublicKey,
      encryptionPublicKey,
    ]);
  if (boundary.device.signingPublicKey !== undefined)
    registeredKeys.push([boundary.device.signingPublicKey, signingPublicKey]);
  for (const [registered, localKey] of registeredKeys) {
    let local: string;
    try {
      local = bytesToHex(
        new Uint8Array(await crypto.subtle.exportKey("raw", localKey)),
      );
    } catch {
      throw new CliError(
        "crypto",
        "the active Device bundle is invalid",
        {},
        "device_bundle_invalid",
      );
    }
    if (local !== registered.toLowerCase())
      throw new CliError(
        "crypto",
        "the saved Device bundle does not match the keys registered on this Server Profile; run dotrelay device recover",
        {},
        "device_bundle_invalid",
      );
  }
  return Object.freeze({
    bundle,
    keys,
    encryptionPublicKey,
    signingPublicKey,
  });
};

const loadAuthorizedDevice = async (
  options: WorkflowOptions,
): Promise<AuthorizedDevice> => {
  const knownDeviceId =
    options.deviceId ??
    (await readDeviceId(
      deviceMetadataPath(options.stateDirectory, options.profile.pin),
    ));
  if (!knownDeviceId)
    throw new CliError(
      "authentication",
      "no Device is enrolled on this installation; run dotrelay login or dotrelay device enroll",
      {},
      "device_bundle_missing",
    );
  const admin = createDeviceAdmin(options, knownDeviceId);
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
    await admin.get("/api/v1/workspace/boundary", workspaceBoundaryFields),
  );
  const { bundle, keys } = await verifyDeviceBundle(
    options,
    boundary,
    knownDeviceId,
    "the local Device is not active on this Server Profile; run dotrelay device enroll or dotrelay device recover",
  );
  return Object.freeze({
    admin,
    boundary,
    userId,
    deviceId: knownDeviceId,
    bundle,
    keys,
  });
};

export const enrollFirstDevice = async (
  options: WorkflowOptions,
): Promise<
  Readonly<{
    deviceId: string;
    active: boolean;
    existing: boolean;
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
  const localDeviceId =
    options.deviceId ??
    (await readDeviceId(
      deviceMetadataPath(options.stateDirectory, options.profile.pin),
    ));
  if (localDeviceId) {
    // This installation already holds a Device. Claim it only after the
    // Server Profile confirms it is this session's active Device and the
    // matching bundle loads from local storage.
    const admin = createDeviceAdmin(options, localDeviceId);
    const session = await admin.get("/api/v1/session", [
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
    const boundary = parseBoundary(
      await admin.get("/api/v1/workspace/boundary", workspaceBoundaryFields),
    );
    try {
      await verifyDeviceBundle(
        options,
        boundary,
        localDeviceId,
        "the local Device is not active on this Server Profile; run dotrelay device enroll or dotrelay device recover",
      );
      return { deviceId: localDeviceId, active: true, existing: true };
    } catch (error) {
      // The recorded Device is not usable for this session: it was revoked
      // or replaced, or the Server Profile reports a different Device.
      // Never claim a remote Device; fall through and enroll this
      // installation's own replacement Device.
      if (!(error instanceof CliError && error.code === "device_not_active"))
        throw error;
    }
  }
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
  return { deviceId: bootstrap.deviceId, active: true, existing: false };
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
  const first = await enrollFirstDevice(options);
  if (first.existing) return beginDeviceEnrollment(options, output);
  return { deviceId: first.deviceId, active: first.active };
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

type CurrentRecoveryEnvelope = Readonly<{
  readonly envelopeId: string;
  readonly recoveryGeneration: number;
}>;

// The service's current envelope is the only authority on which Recovery Kit
// generation it accepted; both the next-generation probe and the uncertain
// publication verification read it.
const readCurrentRecoveryEnvelope = async (
  admin: StrictJsonClient,
): Promise<CurrentRecoveryEnvelope | null> => {
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
      return null;
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
  const envelopeId = current.envelopeId;
  if (typeof envelopeId !== "string" || envelopeId.length === 0)
    throw new CliError(
      "transient",
      "the Server Profile returned an invalid current Recovery Kit envelope",
      {},
      "response_invalid",
    );
  return { envelopeId, recoveryGeneration: Number(parsed) };
};

const nextRecoveryGeneration = async (
  admin: StrictJsonClient,
): Promise<
  Readonly<{
    readonly next: number;
    readonly current: CurrentRecoveryEnvelope | null;
  }>
> => {
  const current = await readCurrentRecoveryEnvelope(admin);
  if (current === null) return { next: 2, current: null };
  return { next: current.recoveryGeneration + 1, current };
};

type PriorRecoveryKit = Readonly<{
  readonly path: string;
  readonly role: "active" | "previous";
  readonly envelopeId?: string;
  readonly recoveryGeneration?: number;
}>;

// The artifact layout keeps the last service-accepted kit (the active file)
// and its retired predecessor (the .previous file) separate from any in-flight
// attempt (the .pending file), so a failed publication can never clobber a
// known-good kit.
const priorRecoveryKits = async (
  output: string,
): Promise<readonly PriorRecoveryKit[]> => {
  const candidates: Array<
    readonly [path: string, role: "active" | "previous"]
  > = [
    [output, "active"],
    [`${output}.previous`, "previous"],
  ];
  const kits: PriorRecoveryKit[] = [];
  for (const [path, role] of candidates) {
    try {
      await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new CliError(
        "local-io",
        "could not read the prior Recovery Kit file",
        {},
        "artifact_read_failed",
      );
    }
    let artifact: RecoveryArtifact | null = null;
    try {
      artifact = await readRecoveryArtifact(path);
    } catch {
      artifact = null;
    }
    kits.push(
      artifact === null
        ? { path, role }
        : {
            path,
            role,
            envelopeId: artifact.envelopeId,
            recoveryGeneration: artifact.recoveryGeneration,
          },
    );
  }
  return kits;
};

const priorRecoveryKitDescription = (kit: PriorRecoveryKit): string =>
  kit.envelopeId === undefined
    ? `${kit.path} (${kit.role} file that is not a recognizable Recovery Kit)`
    : `${kit.path} (${kit.role} kit, envelope ${kit.envelopeId}, generation ${kit.recoveryGeneration})`;

const rotationConfirmQuestion = (
  output: string,
  nextGeneration: number,
  kits: readonly PriorRecoveryKit[],
): string =>
  [
    `Rotate the Recovery Kit at ${output}?`,
    `The new generation ${nextGeneration} kit becomes the active kit.`,
    "These prior kits become obsolete and can no longer restore a Device:",
    ...kits.map((kit) => `  - ${priorRecoveryKitDescription(kit)}`),
  ].join("\n");

// A rotation retires kits that may be the only path to restoring a Device, so
// it never proceeds without approval: --force under --no-input, or an explicit
// interactive confirmation naming the kits that become obsolete.
const approveRecoveryKitRotation = async (
  options: WorkflowOptions,
  output: string,
  nextGeneration: number,
  kits: readonly PriorRecoveryKit[],
): Promise<void> => {
  if (kits.length === 0) return;
  if (options.noInput) {
    if (options.force) return;
    throw new CliError(
      "invocation",
      `rotating the Recovery Kit at ${output} retires ${kits.length === 1 ? "a prior kit" : `${kits.length} prior kits`}; re-run with --force to approve the rotation`,
      {},
      "deletion_requires_approval",
    );
  }
  if (
    !(await confirm(
      options,
      rotationConfirmQuestion(output, nextGeneration, kits),
    ))
  )
    throw new CliInvocationError("recovery kit rotation was declined");
};

// After an uncertain publication the only authority on which generation the
// service accepted is its current envelope, so the active artifact is
// replaced only when the service reports exactly the envelope this attempt
// published.
const verifyRecoveryPublication = async (
  admin: StrictJsonClient,
  envelopeId: string,
  recoveryGeneration: number,
): Promise<"accepted" | "not-accepted" | "unverified"> => {
  let current: CurrentRecoveryEnvelope | null;
  try {
    current = await readCurrentRecoveryEnvelope(admin);
  } catch {
    return "unverified";
  }
  if (current === null) return "not-accepted";
  return current.envelopeId.toLowerCase() === envelopeId.toLowerCase() &&
    current.recoveryGeneration === recoveryGeneration
    ? "accepted"
    : "not-accepted";
};

// A pending attempt left by an earlier interrupted run is either the kit the
// service accepted (and must be promoted) or an attempt it never accepted
// (and must not shadow the next one).
const pendingRecoveryKit = async (
  path: string,
): Promise<RecoveryArtifact | null> => {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(
      "local-io",
      "could not read the pending Recovery Kit file",
      {},
      "artifact_read_failed",
    );
  }
  try {
    return await readRecoveryArtifact(path);
  } catch {
    return null;
  }
};

const discardPendingKit = async (path: string): Promise<void> => {
  await unlink(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
};

const rotationReport = (
  output: string,
  envelopeId: string,
  recoveryGeneration: number,
  priorKits: readonly PriorRecoveryKit[],
  verb: string,
): Readonly<{
  output: string;
  envelopeId: string;
  recoveryGeneration: number;
  rotated: boolean;
  retiredEnvelopeIds: readonly string[];
  previous?: string;
  message: string;
}> => {
  const rotated = priorKits.length > 0;
  const retiredEnvelopeIds = priorKits
    .filter((kit) => kit.envelopeId !== undefined)
    .map((kit) => kit.envelopeId as string);
  return {
    output,
    envelopeId,
    recoveryGeneration,
    rotated,
    retiredEnvelopeIds,
    ...(rotated ? { previous: `${output}.previous` } : {}),
    message: rotated
      ? `${verb} ${output} (generation ${recoveryGeneration}); prior kits are now obsolete: ${priorKits
          .map(priorRecoveryKitDescription)
          .join("; ")}`
      : `${verb} ${output} (generation ${recoveryGeneration})`,
  };
};

export const createRecoveryBackup = async (
  options: WorkflowOptions,
  output: string,
): Promise<
  Readonly<{
    output: string;
    envelopeId: string;
    recoveryGeneration: number;
    rotated: boolean;
    retiredEnvelopeIds: readonly string[];
    previous?: string;
    message: string;
  }>
> => {
  const authorized = await loadAuthorizedDevice(options);
  const { next: recoveryGeneration, current } = await nextRecoveryGeneration(
    authorized.admin,
  );
  const pendingPath = `${output}.pending`;
  // Locate the prior artifacts before staging anything: a rotation must name
  // the kits it retires, and a failed attempt must never reach them.
  const priorKits = await priorRecoveryKits(output);
  const pendingKit = await pendingRecoveryKit(pendingPath);
  const pendingAccepted =
    pendingKit !== null &&
    current !== null &&
    pendingKit.envelopeId.toLowerCase() === current.envelopeId.toLowerCase() &&
    pendingKit.recoveryGeneration === current.recoveryGeneration;
  if (pendingAccepted) {
    // An earlier, interrupted run staged the kit the service now accepts.
    // Promote it instead of overwriting it with a new attempt, so the last
    // service-accepted kit is never lost to a retry.
    await approveRecoveryKitRotation(
      options,
      output,
      current.recoveryGeneration,
      priorKits,
    );
    const pendingText = await readFile(pendingPath, "utf8");
    await atomicWriteProtectedFile(output, pendingText, {
      retainPrevious: true,
    });
    await discardPendingKit(pendingPath);
    return rotationReport(
      output,
      pendingKit.envelopeId,
      current.recoveryGeneration,
      priorKits,
      "Promoted the service-accepted Recovery Kit",
    );
  }
  if (pendingKit !== null)
    // A pending attempt the service never accepted must not shadow the next
    // one.
    await discardPendingKit(pendingPath);
  await approveRecoveryKitRotation(
    options,
    output,
    recoveryGeneration,
    priorKits,
  );
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
  // Stage the attempt in a file that no failure mode can mistake for the
  // active kit; the active artifact is replaced only after the service has
  // accepted the new generation.
  const pendingText = `${JSON.stringify(artifact)}\n`;
  await atomicWriteProtectedFile(pendingPath, pendingText);
  const operationId = crypto.randomUUID();
  let publication: unknown = null;
  try {
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
  } catch (error) {
    publication = error;
  }
  if (publication !== null) {
    // A definitive rejection cannot have been accepted; an uncertain failure
    // must be reconciled against the service's current envelope first.
    const definitive =
      publication instanceof CliError && publication.category !== "transient";
    if (definitive) {
      await discardPendingKit(pendingPath);
      throw publication;
    }
    const verified = await verifyRecoveryPublication(
      authorized.admin,
      envelopeId,
      recoveryGeneration,
    );
    if (verified === "not-accepted") {
      await discardPendingKit(pendingPath);
      throw publication;
    }
    if (verified === "unverified") {
      throw new CliError(
        "transient",
        `the Recovery Kit publication outcome is unverified; the pending kit is retained at ${pendingPath} and the last service-accepted kit at ${output} is unchanged; re-run device backup to verify which generation the service accepted`,
        {},
        "service_unavailable",
      );
    }
    // The service accepted this attempt even though the response was lost.
  }
  await atomicWriteProtectedFile(output, pendingText, { retainPrevious: true });
  await discardPendingKit(pendingPath);
  return rotationReport(
    output,
    envelopeId,
    recoveryGeneration,
    priorKits,
    "Wrote Recovery Kit",
  );
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

type PendingRecovery = Readonly<{
  readonly serverProfileId: string;
  readonly userId: string;
  readonly envelopeId: string;
  readonly identityGeneration: number;
  readonly recoveryGeneration: number;
  readonly replacementDeviceId: string;
  readonly operationId: string;
  readonly challenge: Uint8Array;
  readonly expiresAtMs: number;
  readonly proof: Uint8Array;
  readonly certificateId: string;
  readonly certificate: Uint8Array;
}>;

const recoveryStatePath = (
  directory: string,
  profile: ServerProfilePin,
): string => join(directory, `device-${profile.serverProfileId}.recovery.json`);

// The pending record pins every value the restore request is built from, so
// an uncertain response can be re-posted as the same logical operation
// instead of starting a fresh one.
const readPendingRecovery = async (
  path: string,
): Promise<PendingRecovery | null> => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(
      "local-io",
      "could not read the pending Recovery Kit restore",
      {},
      "context_read_failed",
    );
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== "dotrelay-pending-recovery-restore"
  )
    throw new CliError(
      "local-io",
      "the pending Recovery Kit restore is invalid",
      {},
      "context_read_failed",
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
      "local-io",
      "the pending Recovery Kit restore is invalid",
      {},
      "context_read_failed",
    );
  const expiresAt =
    typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)
    throw new CliError(
      "local-io",
      "the pending Recovery Kit restore is invalid",
      {},
      "context_read_failed",
    );
  const challenge = fromBase64(value.challenge, "pending recovery challenge");
  if (challenge.length !== 32)
    throw new CliError(
      "local-io",
      "the pending Recovery Kit restore is invalid",
      {},
      "context_read_failed",
    );
  return Object.freeze({
    serverProfileId: requiredString(
      value.serverProfileId,
      "pending recovery field",
    ),
    userId: requiredString(value.userId, "pending recovery field"),
    envelopeId: requiredString(value.envelopeId, "pending recovery field"),
    identityGeneration,
    recoveryGeneration,
    replacementDeviceId: requiredString(
      value.replacementDeviceId,
      "pending recovery field",
    ),
    operationId: requiredString(value.operationId, "pending recovery field"),
    challenge,
    expiresAtMs: expiresAt,
    proof: fromBase64(value.proof, "pending recovery proof"),
    certificateId: requiredString(
      value.certificateId,
      "pending recovery field",
    ),
    certificate: fromBase64(value.certificate, "pending recovery certificate"),
  });
};

const writePendingRecovery = async (
  path: string,
  pending: PendingRecovery,
): Promise<void> => {
  await atomicWriteProtectedFile(
    path,
    `${JSON.stringify({
      version: 1,
      kind: "dotrelay-pending-recovery-restore",
      serverProfileId: pending.serverProfileId,
      userId: pending.userId,
      envelopeId: pending.envelopeId,
      identityGeneration: pending.identityGeneration,
      recoveryGeneration: pending.recoveryGeneration,
      replacementDeviceId: pending.replacementDeviceId,
      operationId: pending.operationId,
      challenge: base64(pending.challenge),
      expiresAt: new Date(pending.expiresAtMs).toISOString(),
      proof: base64(pending.proof),
      certificateId: pending.certificateId,
      certificate: base64(pending.certificate),
    })}\n`,
  );
};

const clearPendingRecovery = async (path: string): Promise<void> => {
  await unlink(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
};

const loadRecoveryIdentity = async (
  options: WorkflowOptions,
  allowActiveDevices = false,
): Promise<
  Readonly<{ admin: StrictJsonClient; boundary: Boundary; userId: string }>
> => {
  const localDeviceId = await readDeviceId(
    deviceMetadataPath(options.stateDirectory, options.profile.pin),
  );
  const admin = createDeviceAdmin(options, localDeviceId ?? undefined);
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
    await admin.get("/api/v1/workspace/boundary", workspaceBoundaryFields),
  );
  // Recovery restores a replacement Device for the whole User, so it is
  // blocked while any of the User's Devices is active on the Server Profile.
  // Resuming an in-flight restore skips the check: the in-flight replacement
  // is the only Device that restore may activate, and the idempotent restore
  // request reconciles the service-side outcome before any local commit.
  if (
    !allowActiveDevices &&
    (boundary.device.active || boundary.activeDeviceCount > 0)
  )
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
  // A pending restore that matches this Kit's operation is resumed instead of
  // re-created, so the pending record is located before the no-active-Device
  // check: its in-flight replacement Device is the only active Device the
  // resume may observe.
  const statePath = recoveryStatePath(
    options.stateDirectory,
    options.profile.pin,
  );
  const pending = await readPendingRecovery(statePath);
  const resuming =
    pending !== null &&
    pending.serverProfileId.toLowerCase() ===
      options.profile.pin.serverProfileId.toLowerCase() &&
    pending.userId.toLowerCase() === artifact.userId.toLowerCase() &&
    pending.envelopeId.toLowerCase() === artifact.envelopeId.toLowerCase() &&
    pending.identityGeneration === artifact.identityGeneration &&
    pending.recoveryGeneration === artifact.recoveryGeneration;
  const identity = await loadRecoveryIdentity(options, resuming);
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
    opened.recoveryGeneration !== artifact.recoveryGeneration ||
    (resuming &&
      pending.replacementDeviceId.toLowerCase() !==
        opened.replacementDeviceId.toLowerCase())
  )
    throw new CliError(
      "crypto",
      resuming
        ? "the pending Recovery Kit restore does not match its Kit"
        : "the Recovery Kit metadata does not match its envelope",
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
  let operation: PendingRecovery;
  if (resuming) {
    if (pending.expiresAtMs <= Date.now()) {
      await clearPendingRecovery(statePath);
      throw new CliError(
        "conflict",
        "the pending Recovery Kit restore has expired; create a new Recovery Kit",
        {},
        "device_authorization_expired",
      );
    }
    operation = pending;
  } else {
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
    operation = Object.freeze({
      serverProfileId: options.profile.pin.serverProfileId,
      userId: identity.userId,
      envelopeId: opened.envelopeId,
      identityGeneration: opened.identityGeneration,
      recoveryGeneration: opened.recoveryGeneration,
      replacementDeviceId: opened.replacementDeviceId,
      operationId: crypto.randomUUID(),
      challenge,
      expiresAtMs: challengeExpiresAtMs,
      proof: proof.canonicalBytes,
      certificateId: crypto.randomUUID(),
      certificate,
    });
    // Persist the operation before it is submitted so an uncertain response
    // can be reconciled as the same logical operation, with the same
    // operation id and pending key material.
    await writePendingRecovery(statePath, operation);
  }
  // The replacement bundle is stored under its own Device scope as the
  // pending key material; it does not change the active Device selection.
  await storage.save(bundle);
  let response: Record<string, unknown>;
  try {
    response = await identity.admin.post(
      "/api/v1/recovery/restore",
      {
        operationId: operation.operationId,
        objectId: opened.envelopeId,
        envelope: base64(encodeProtocolObject(opened.envelope)),
        object: base64(encodeProtocolObject(opened.envelope)),
        envelopeId: opened.envelopeId,
        identityGeneration: String(opened.identityGeneration),
        recoveryGeneration: String(opened.recoveryGeneration),
        deviceId: opened.replacementDeviceId,
        challenge: base64(operation.challenge),
        expiresAt: new Date(operation.expiresAtMs).toISOString(),
        proof: base64(operation.proof),
        replacementEncryptionPublicKey: base64(rawEncryptionPublicKey),
        replacementSigningPublicKey: base64(rawSigningPublicKey),
        x25519PublicKey: base64(rawEncryptionPublicKey),
        ed25519PublicKey: base64(rawSigningPublicKey),
        keyId: base64(await sha384(rawEncryptionPublicKey)),
        certificateId: operation.certificateId,
        certificate: base64(operation.certificate),
      },
      ["deviceId", "active", "recoveryGeneration", "idempotent"],
      { idempotencyKey: operation.operationId },
    );
  } catch (error) {
    // A definitive rejection leaves nothing in flight, so the pending record
    // is discarded and the prior Device selection stands. A transient failure
    // may still have reached the service, so the pending operation must
    // survive for the next reconciliation attempt.
    if (error instanceof CliError && error.category !== "transient")
      await clearPendingRecovery(statePath);
    throw error;
  }
  // The approval identifies the Device selection that becomes active. The
  // local selection switches only for the exact replacement Device this
  // operation prepared.
  if (
    response.active !== true ||
    typeof response.deviceId !== "string" ||
    response.deviceId.toLowerCase() !== opened.replacementDeviceId.toLowerCase()
  )
    throw new CliError(
      "transient",
      "the Server Profile did not confirm this replacement Device",
      {},
      "response_invalid",
    );
  await writeDeviceId(
    deviceMetadataPath(options.stateDirectory, options.profile.pin),
    options.profile.pin,
    opened.replacementDeviceId,
  );
  await clearPendingRecovery(statePath);
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

const adminClient = (options: WorkflowOptions): StrictJsonClient =>
  options.admin ??
  createStrictJsonClient(options.profile.pin, options.credentials, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

// A single invocation loads the workflow session once per phase. When init
// creates an Environment in the first phase, the later phases must reuse that
// id instead of creating another Environment to publish into. Each CLI process
// builds a fresh options object per run, so object identity tracks the
// invocation; in-process callers that reuse one options object across runs
// (test harnesses) share the memo, which is the intended behaviour.
const createdEnvironmentByInvocation = new WeakMap<object, string>();

const loadWorkflowSession = async (
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
  const requestedEnvironment =
    options.environmentId ??
    resolveRequestedEnvironmentId(parsed, localContext);
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
  let epochKey: Uint8Array | undefined;
  if (!boundary.grantsReady) {
    epochKey = await bootstrapProjectGrant(
      options,
      token,
      boundary,
      deviceId,
      keys,
    );
  } else if (boundary.epochGrant) {
    epochKey = await openProjectEpochGrant(
      fromBase64(boundary.epochGrant, "Project epoch grant"),
      keys.encryptionPrivateKey,
    );
  }
  if (epochKey)
    await wrapEpochKeyToPeers(
      options,
      token,
      boundary,
      deviceId,
      keys,
      epochKey,
    );
  const transport = createProtocolTransport({
    origin: options.profile.origin,
    authorization: `Bearer ${token}`,
    ...(options.fetch ? { fetch: options.fetch as never } : {}),
  });
  const signingPublicKey = await exportSigningPublicKey(deviceSigningPublicKey);
  const signingTrustKeys = collectSigningTrustKeys(boundary, signingPublicKey);
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
  };
  const session = createVerifiedEnvironmentSession({
    context: publicationContext,
    transport,
    sharedValuePrivateKey: keys.encryptionPrivateKey,
    userDefinedValuePrivateKey: keys.encryptionPrivateKey,
    signingTrustKeys,
    ...(epochKey ? { sharedValueSecret: epochKey } : {}),
  });
  return {
    boundary,
    bundle,
    keys,
    deviceId,
    transport,
    publicationContext,
    session,
    ...(createdEnvironmentId ? { createdEnvironmentId } : {}),
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

const classificationFromOwnership = (
  ownership: DecodedVariable["ownership"],
): "shared" | "user-defined" =>
  ownership === "SHARED_VALUE" ? "shared" : "user-defined";

const toDotenvClassifications = (
  classifications: Readonly<Record<string, "shared" | "user-defined">>,
) =>
  Object.fromEntries(
    Object.entries(classifications).map(([name, classification]) => [
      name,
      { classification },
    ]),
  );

const classify = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
  entries: readonly DotenvEntry[],
  existing: readonly DecodedVariable[],
): Promise<readonly ClassifiedDotenvEntry[]> => {
  const provided: Record<string, "shared" | "user-defined"> = {
    ...parsed.classifications,
  };
  for (const variable of existing) {
    if (variable.tombstone) continue;
    if (!(variable.name in provided))
      provided[variable.name] = classificationFromOwnership(variable.ownership);
  }
  const missing = entries.filter((entry) => !(entry.name in provided));
  if (missing.length === 0)
    return classifyDotenv(entries, toDotenvClassifications(provided));
  if (options.noInput)
    throw new CliInvocationError(
      "new Variables require --classify NAME=shared|user-defined under --no-input",
    );
  const selected = await classifyVariablesInteractively(
    missing.map((entry) => entry.name),
    provided,
    {
      ...(options.terminal ? { terminal: options.terminal } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    },
  );
  return classifyDotenv(
    entries,
    toDotenvClassifications({ ...provided, ...selected }),
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

type PublicationDraft = ReturnType<typeof toPublicationVariable>;

const publicationChangeFor = (
  variable: PublicationDraft,
  existing: readonly DecodedVariable[],
): PublicationChange | null => {
  if (!variable.hasDraftChange) return null;
  const prior = existing.find((candidate) => candidate.id === variable.id);
  const ownership = classificationFromOwnership(variable.ownership);
  if (variable.tombstone)
    return Object.freeze({
      kind: "removed",
      name: variable.name,
      from: prior?.value ?? null,
      to: undefined,
      ownership,
    });
  if (!prior || prior.tombstone)
    return Object.freeze({
      kind: "added",
      name: variable.name,
      from: undefined,
      to: variable.value,
      ownership,
    });
  return Object.freeze({
    kind: "updated",
    name: variable.name,
    from: prior.value,
    to: variable.value,
    ownership,
  });
};

const destinationFor = async (
  options: WorkflowOptions,
  context: PublicationContext,
): Promise<PublicationDestination> => {
  // A missing metadata lookup degrades the review to opaque ids; it must
  // never block an operation the operator is about to confirm.
  let environment:
    | Awaited<ReturnType<typeof listEnvironments>>[number]
    | undefined;
  let team: Awaited<ReturnType<typeof listTeams>>[number] | undefined;
  try {
    const admin = adminClient(options);
    const [environments, teams] = await Promise.all([
      listEnvironments(admin, context.projectId),
      listTeams(admin),
    ]);
    environment = environments.find(
      (entry) => entry.id === context.environmentId,
    );
    team = teams.find((entry) => entry.id === context.teamId);
  } catch {
    // Keep the confirmation reachable even when metadata is unavailable.
  }
  return Object.freeze({
    profile: options.profile.name,
    team: team?.name ?? context.teamId ?? "unknown",
    project: context.projectId,
    environment: environment?.label ?? context.environmentId ?? "unknown",
  });
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
  const draftVariables = variables.map((variable) =>
    toPublicationVariable(variable, synced.variables),
  );
  if (!draftVariables.some((variable) => variable.hasDraftChange))
    return {
      revision: synced.page.currentHeadId,
      lanes: 0,
      tombstones: 0,
      message: "Already published",
    };
  const changes = draftVariables
    .map((variable) => publicationChangeFor(variable, synced.variables))
    .filter((change): change is PublicationChange => change !== null);
  const removedCount = changes.filter(
    (change) => change.kind === "removed",
  ).length;
  if (options.noInput && removedCount > 0 && !options.force)
    throw new CliError(
      "invocation",
      `publishing ${removedCount} removed ${removedCount === 1 ? "Variable" : "Variables"} requires explicit approval; re-run with --force`,
      { changedCount: removedCount },
      "deletion_requires_approval",
    );
  if (!options.noInput) {
    const destination = await destinationFor(
      options,
      synced.workflow.publicationContext,
    );
    if (
      !(await confirm(
        options,
        publicationConfirmQuestion(changes, destination, parsed.reveal),
      ))
    )
      throw new CliInvocationError("publication confirmation was declined");
  }
  const progress = (title: string): void => {
    if (options.noInput || parsed.json) return;
    writeNotice(options.terminal?.output ?? process.stderr, title);
  };
  progress("Encrypting");
  let artifacts: Awaited<ReturnType<typeof createPublicationArtifacts>>;
  try {
    artifacts = await createPublicationArtifacts(draftVariables, context);
    assertPublicationAccepted(reviewPublication(artifacts.commandBytes));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "invocation",
      sanitizeCliText(
        error instanceof Error
          ? error.message
          : "could not build the publication",
      ).slice(0, 512) || "could not build the publication",
      {},
      "publication_invalid",
    );
  }
  const operationId = crypto.randomUUID();
  progress("Uploading");
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
      "genesis_exists",
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
  progress("Published");
  return {
    revision: artifacts.request.revision.id,
    lanes: artifacts.encryptedLaneCount,
    tombstones: artifacts.tombstoneLaneCount,
    message: "Published",
  };
};

const shareEnvironmentWithPeerDevices = async (
  synced: Awaited<ReturnType<typeof syncWorkflow>>,
): Promise<void> => {
  const epochKey = synced.workflow.publicationContext.sharedValueSecret;
  if (
    !epochKey ||
    synced.workflow.boundary.peerDevices.length === 0 ||
    synced.variables.filter((variable) => !variable.tombstone).length === 0
  )
    return;
  const probe = await generateEncryptionKeyPair();
  try {
    await decodeSyncVariables(
      synced.page,
      () => probe.privateKey,
      [],
      epochKey,
    );
    return;
  } catch {
    // Shared Values are still sealed to this Device. Republish them with the
    // Project epoch key so other Devices can read them.
  }
  const context: PublicationContext = {
    ...synced.workflow.publicationContext,
    expectedHeadId: synced.page.currentHeadId,
    expectedHeadHash: synced.page.currentHeadHash,
    projectEpoch: safeProjectEpoch(synced.page.projectEpoch),
    mutation: synced.page.currentHeadId ? "MANIFEST_UPDATE" : "GENESIS",
  };
  const draft = synced.variables.map((variable) =>
    Object.freeze({
      ...variable,
      hasDraftChange: true,
    }),
  );
  const artifacts = await createPublicationArtifacts(draft, context);
  assertPublicationAccepted(reviewPublication(artifacts.commandBytes));
  const operationId = crypto.randomUUID();
  const deviceId = synced.workflow.deviceId;
  try {
    await synced.workflow.transport.begin({
      operationId,
      deviceId,
      kind: "REVISION_PUBLICATION",
      commandBytes: artifacts.commandBytes,
      commandDigest: await sha384(artifacts.commandBytes),
    });
    for (const staged of artifacts.stagedObjects)
      await synced.workflow.transport.stage({
        operationId,
        deviceId,
        objectId: staged.objectId,
        bytes: staged.bytes,
      });
    await synced.workflow.transport.finalize({
      operationId,
      deviceId,
      request: artifacts.request,
    });
  } catch (error) {
    await synced.workflow.transport
      .cancel({ operationId, deviceId })
      .catch(() => undefined);
    throw error instanceof CliError
      ? error
      : new CliError(
          "transient",
          "could not share this Environment with your other Devices",
          {},
          "peer_share_failed",
        );
  }
};

const ownershipByName = (
  variables: readonly DecodedVariable[],
): ReadonlyMap<string, ValueOwnership> => {
  const ownership = new Map<string, ValueOwnership>();
  for (const variable of variables) {
    if (variable.tombstone) continue;
    ownership.set(
      variable.name,
      classificationFromOwnership(variable.ownership),
    );
  }
  return ownership;
};

const withOwnership = (
  changes: readonly DotenvDiffChange[],
  variables: readonly DecodedVariable[],
): readonly DotenvDiffChange[] => {
  const known = ownershipByName(variables);
  return Object.freeze(
    changes.map((change) => {
      const value = known.get(change.name);
      return value ? Object.freeze({ ...change, ownership: value }) : change;
    }),
  );
};

const trackedPullOutputDetail = (outputPath: string): string =>
  [
    `${outputPath} is tracked by Git; the next git add/commit could publish the decrypted Values written to it.`,
    "Choose one before re-running pull:",
    `  1. Untrack it (keeps your local file): git rm --cached ${outputPath}`,
    "  2. Pull to a different path: dotrelay pull --output <path>",
    "DotRelay never changes Git history or removes tracked content on your behalf.",
  ].join("\n");

const guardPullOutputAgainstGit = async (
  options: WorkflowOptions,
  outputPath: string,
): Promise<"established" | "present" | undefined> => {
  const probe = options.gitTracking ?? createGitTrackingProbe();
  const tracking = await probe(resolve(outputPath));
  if (tracking.state === "tracked")
    throw new CliError(
      "conflict",
      trackedPullOutputDetail(outputPath),
      {},
      "output_tracked",
    );
  if (tracking.state === "untracked") return ensureLocalGitExclusion(tracking);
  if (tracking.state === "ignored") return "present";
  return undefined;
};

const localPullChanges = async (
  outputPath: string,
  incoming: readonly DotenvEntry[],
  variables: readonly DecodedVariable[],
): Promise<readonly PublicationChange[] | null> => {
  let source: string;
  try {
    source = await readFile(outputPath, "utf8");
  } catch {
    return null;
  }
  try {
    return valueDiffsForPull(
      withOwnership(
        diffDotenvEntries(parseDotenv(source), incoming),
        variables,
      ),
    );
  } catch {
    return null;
  }
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
  if (parsed.command === "diff") {
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
    const local = parseDotenv(source);
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
    const remote = synced.variables
      .filter((variable) => !variable.tombstone)
      .map((variable) =>
        Object.freeze({ name: variable.name, value: variable.value ?? "" }),
      );
    const changes = withOwnership(
      diffDotenvEntries(local, remote),
      synced.variables,
    );
    const added = Object.freeze(
      changes
        .filter((change) => change.kind === "added")
        .map((change) => change.name),
    );
    const updated = Object.freeze(
      changes
        .filter((change) => change.kind === "updated")
        .map((change) => change.name),
    );
    const removed = Object.freeze(
      changes
        .filter((change) => change.kind === "removed")
        .map((change) => change.name),
    );
    const unchangedCount =
      local.length -
      changes.filter(
        (change) => change.kind === "added" || change.kind === "updated",
      ).length;
    if (parsed.json) return { added, updated, removed, unchangedCount };
    return { stdout: renderEnvDiff(changes, parsed.reveal) };
  }
  if (parsed.command === "pull") {
    const outputPath = parsed.stdout ? undefined : (parsed.output ?? ".env");
    if (!outputPath && !parsed.stdout)
      throw new CliInvocationError("pull requires --output <file> or --stdout");
    // Check Git exposure before any Value is decrypted or moved: a tracked
    // output is refused up front and an untracked one gets a repository-local
    // exclusion so a later git add cannot pick the plaintext file up.
    let gitExclusion: "established" | "present" | undefined;
    if (outputPath)
      gitExclusion = await guardPullOutputAgainstGit(options, outputPath);
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
    await shareEnvironmentWithPeerDevices(synced);
    const entries = synced.variables
      .filter((variable) => !variable.tombstone)
      .map((variable) => ({
        name: variable.name,
        value: variable.value ?? "",
      }));
    const contents = serializeDotenv(entries);
    if (parsed.stdout && parsed.reveal && !options.noInput) {
      const destination = await destinationFor(
        options,
        synced.workflow.publicationContext,
      );
      const question = [
        ...renderDestinationLines(destination),
        `Reveal ${entries.length} decrypted Values to stdout?`,
      ].join("\n");
      if (!(await confirm(options, question)))
        throw new CliInvocationError("Value reveal confirmation was declined");
    }
    let replaceExisting = false;
    if (outputPath) {
      let existingFile = false;
      try {
        existingFile = (await stat(outputPath)).isFile();
      } catch {
        existingFile = false;
      }
      if (existingFile) {
        const changes = await localPullChanges(
          outputPath,
          entries,
          synced.variables,
        );
        if (changes !== null && changes.length === 0)
          return {
            output: outputPath,
            unchanged: true,
            ...(gitExclusion ? { gitExclusion } : {}),
            message: "No changes found",
          };
        if (options.noInput) {
          if (!options.force)
            throw new CliError(
              "conflict",
              `${outputPath} differs from the Environment and was retained; re-run with --force to replace it`,
              changes !== null ? { changedCount: changes.length } : {},
              "output_conflict",
            );
        } else {
          const destination = await destinationFor(
            options,
            synced.workflow.publicationContext,
          );
          if (
            !(await confirm(
              options,
              pullConfirmQuestion(
                outputPath,
                changes,
                destination,
                parsed.reveal,
              ),
            ))
          )
            throw new CliInvocationError("pull confirmation was declined");
        }
        replaceExisting = true;
      }
    }
    assertSafeStdout({
      requested: parsed.stdout,
      terminal: options.stdoutIsTerminal,
      reveal: parsed.reveal,
    });
    if (outputPath)
      await atomicWriteProtectedFile(outputPath, contents, {
        ...(replaceExisting ? { retainPrevious: true } : {}),
      });
    const exclusionNote =
      gitExclusion === "established"
        ? `; ${outputPath} is excluded from Git via .git/info/exclude so it will not be tracked`
        : "";
    return parsed.stdout
      ? { stdout: contents }
      : {
          output: outputPath ?? "",
          ...(gitExclusion ? { gitExclusion } : {}),
          ...(replaceExisting ? { previous: `${outputPath}.previous` } : {}),
          message: replaceExisting
            ? `Wrote ${entries.length} values to ${outputPath}; prior file retained at ${outputPath}.previous${exclusionNote}`
            : `Wrote ${entries.length} values to ${outputPath}${exclusionNote}`,
        };
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
    const synced = await syncWorkflow(options, parsed);
    const empty = synced.page.currentHeadId === null;
    const existing = synced.variables;
    const entries = await classify(
      options,
      parsed,
      parseDotenv(source),
      existing,
    );
    const variables = variablesFromDotenv(entries, existing);
    const result = await publish(
      options,
      parsed,
      variables,
      empty ? "GENESIS" : "MANIFEST_UPDATE",
    );
    // The worktree selection is persisted only after a successful
    // publication, so the Environment created by init is reused by later
    // invocations instead of a second one being created.
    if (parsed.command === "init" && synced.workflow.createdEnvironmentId) {
      const { writeWorktreeContext } = await import("./context");
      await writeWorktreeContext(options.contextPath, {
        serverProfileId: synced.workflow.publicationContext.serverProfileId,
        projectId: synced.workflow.publicationContext.projectId,
        environmentId: synced.workflow.createdEnvironmentId,
      });
    }
    return result;
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
