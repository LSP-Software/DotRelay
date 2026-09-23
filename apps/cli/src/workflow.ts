import { readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type AccountKeyTrustedKeys,
  assertPublicationAccepted,
  type CliDeviceStorage,
  changedVariableIdsFromRevision,
  createAccountKeyEnvelope,
  createAccountKeyTransfer,
  createAccountKeyWrapper,
  createCliDeviceStorage,
  createDeviceBootstrap,
  createDeviceEnrollmentApproval,
  createDeviceEnrollmentRequest,
  createProjectEpochGrantBootstrap,
  createProtocolTransport,
  createPublicationArtifacts,
  createVerifiedEnvironmentSession,
  type DecodedVariable,
  type DeviceEnrollmentRequest,
  type DeviceKeyMaterial,
  type DevicePrivateBundle,
  decodeRecoveryCode,
  decodeSyncVariables,
  encodeRecoveryCode,
  exportSigningPublicKey,
  generateAccountMasterKey,
  generateRecoveryCode,
  loadDeviceKeyMaterial,
  openAccountKeyEnvelope,
  openAccountKeyTransfer,
  openProjectEpochGrant,
  type ProtocolTransport,
  type PublicationContext,
  parseAccountKeyEnvelope,
  parseAccountKeyTransfer,
  parseAccountKeyWrapper,
  parseDeviceEnrollmentTranscript,
  type RevisionSigningTrust,
  type RevisionSigningTrustEntry,
  reviewPublication,
  type SyncPageWire,
  UnreadableLaneError,
  unwrapAccountKeyWrapper,
  verifySignedProtocolObject,
} from "@dotrelay/client";
import {
  encodeProtocolObject,
  generateEncryptionKeyPair,
  parseProtocolObject,
  type SyncRevisionWire,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  createEnvironment,
  createStrictJsonClient,
  listEnvironments,
  listTeams,
  resolveEnvironmentReference,
  type StrictJsonClient,
} from "./admin";
import type { ParsedArguments } from "./args";
import { createSessionStore } from "./auth";
import { classifyVariablesInteractively } from "./classify-ui";
import { heading, kv, note, reviewFrame, stepDone } from "./components";
import type { CredentialStore } from "./credentials";
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
import {
  CliError,
  CliInvocationError,
  categoryForProblem,
  sanitizeCliText,
} from "./errors";
import {
  createGitTrackingProbe,
  ensureLocalGitExclusion,
  type GitTrackingProbe,
} from "./git-tracking";
import {
  defaultNetworkPolicy,
  fetchWithDeadline,
  NetworkAttemptError,
  type NetworkPolicy,
  networkFailureCliError,
} from "./network";
import { assertSafeStdout, atomicWriteProtectedFile } from "./output";
import type { CliServerProfile, FetchFunction } from "./profile";
import { createProgress, type Progress } from "./progress";
import { readTerminalLine, type TerminalIo } from "./terminal";
import { pad, type Tone, visibleWidth } from "./theme";
import {
  confirmAction,
  paint,
  parseConfirmAnswer,
  readTerminalSecret,
} from "./ui";
import {
  destinationRows,
  type PublicationChange,
  type PublicationDestination,
  publicationConfirmQuestion,
  pullConfirmQuestion,
  ROLLBACK_NOTE,
  renderEnvDiff,
  reviewBody,
  rollbackConfirmQuestion,
  type ValueOwnership,
  valueDiffsForPull,
} from "./value-diff";

export type WorkflowOptions = Readonly<{
  readonly profile: CliServerProfile;
  readonly credentials: CredentialStore;
  readonly fetch?: FetchFunction;
  readonly networkPolicy?: NetworkPolicy;
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
  readonly accountKeyEnvelope?: string;
  readonly signingTrustKeys: readonly string[];
  readonly signingTrustDevices: readonly SigningTrustDevice[];
  readonly peerDevices: readonly Readonly<{
    readonly id: string;
    readonly encryptionPublicKey: string;
    readonly signingPublicKey: string;
    readonly hasEpochGrant: boolean;
  }>[];
}>;

type SigningTrustDevice = Readonly<{
  readonly deviceId: string;
  readonly userId: string;
  readonly signingPublicKey: string;
  readonly deviceActiveFromMs: number | null;
  readonly deviceActiveUntilMs: number | null;
  readonly memberSinceMs: number | null;
  readonly memberUntilMs: number | null;
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
  readonly pendingActions: readonly string[];
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

export const workspaceBoundaryFields = [
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
  "signingTrustDevices",
  "epochGrant",
  "accountKeyEnvelope",
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
    ...(typeof value.accountKeyEnvelope === "string"
      ? { accountKeyEnvelope: value.accountKeyEnvelope }
      : {}),
    signingTrustKeys: Array.isArray(value.signingTrustKeys)
      ? value.signingTrustKeys.filter(
          (key): key is string => typeof key === "string",
        )
      : [],
    signingTrustDevices: Array.isArray(value.signingTrustDevices)
      ? value.signingTrustDevices.flatMap((entry): SigningTrustDevice[] => {
          if (!isRecord(entry)) return [];
          const isMillis = (candidate: unknown): candidate is number | null =>
            candidate === null ||
            (typeof candidate === "number" && Number.isSafeInteger(candidate));
          if (
            typeof entry.deviceId !== "string" ||
            typeof entry.userId !== "string" ||
            typeof entry.signingPublicKey !== "string" ||
            !isMillis(entry.deviceActiveFromMs) ||
            !isMillis(entry.deviceActiveUntilMs) ||
            !isMillis(entry.memberSinceMs) ||
            !isMillis(entry.memberUntilMs)
          )
            return [];
          return [
            {
              deviceId: entry.deviceId,
              userId: entry.userId,
              signingPublicKey: entry.signingPublicKey,
              deviceActiveFromMs: entry.deviceActiveFromMs,
              deviceActiveUntilMs: entry.deviceActiveUntilMs,
              memberSinceMs: entry.memberSinceMs,
              memberUntilMs: entry.memberUntilMs,
            },
          ];
        })
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

// The boundary names the Team's authorized signing Devices with their Device
// and Membership windows; that scoped set replaces the flat key list so a
// Device revoked after it signed a legitimate Revision stays verifiable,
// while a write made after the revocation is not. A boundary without the set
// (an older service) falls back to the flat keys it does report.
const collectSigningTrust = (
  boundary: Boundary,
  localSigningPublicKey: Uint8Array,
): RevisionSigningTrust => {
  if (boundary.signingTrustDevices.length > 0) {
    const entries: RevisionSigningTrustEntry[] = [];
    const seen = new Set<string>();
    for (const device of boundary.signingTrustDevices) {
      let publicKey: Uint8Array;
      try {
        publicKey = hexToBytes(device.signingPublicKey);
      } catch {
        continue;
      }
      const hex = bytesToHex(publicKey);
      if (seen.has(hex)) continue;
      seen.add(hex);
      entries.push({
        publicKey,
        deviceId: device.deviceId,
        userId: device.userId,
        deviceActiveFromMs: device.deviceActiveFromMs,
        deviceActiveUntilMs: device.deviceActiveUntilMs,
        memberSinceMs: device.memberSinceMs,
        memberUntilMs: device.memberUntilMs,
      });
    }
    // This installation's own key is the one fallback that needs no window:
    // the service only ever accepted its writes while it was authorized.
    const localHex = bytesToHex(localSigningPublicKey);
    if (!seen.has(localHex)) entries.push({ publicKey: localSigningPublicKey });
    return entries;
  }
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

// Assemble the set of Ed25519 signing public keys (raw 32-byte) that are
// trusted to have signed an account-key object on this Server Profile: the
// local Device's key, the boundary's signing-trust devices, and peer Devices.
// For API-issued objects the creator Device is one of these (or the caller adds
// the creatorPublicKey from the response), so verifying against this set plus
// the creator key authorizes the signature (R9).
const accountKeyTrustedKeys = (
  boundary: Boundary,
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
  for (const device of boundary.signingTrustDevices)
    addHex(device.signingPublicKey);
  for (const key of boundary.signingTrustKeys) addHex(key);
  if (boundary.device.signingPublicKey)
    addHex(boundary.device.signingPublicKey);
  for (const peer of boundary.peerDevices)
    if (peer.signingPublicKey.length > 0) addHex(peer.signingPublicKey);
  for (const key of extraKeys) addHex(key);
  return Object.freeze({ keys });
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

// On a raw terminal the question is answered in the boxed Yes/No selector:
// Enter approves the highlighted choice, Esc declines. Every other input
// (injected prompt, piped stdin, --no-input) keeps the typed y/N answer.
const terminalConfirm = async (
  options: WorkflowOptions,
  question: string,
  silent: boolean,
): Promise<boolean> => {
  try {
    return await confirmAction(question, {
      ...(options.terminal ? { terminal: options.terminal } : {}),
      ...(silent ? { silent: true } : {}),
      default: "no",
    });
  } catch (error) {
    if (error instanceof CliInvocationError) throw error;
    throw new CliInvocationError(
      "the terminal could not be read, so the interactive prompt went unanswered",
    );
  }
};

// The review frame has already printed the question, so the terminal read
// must not echo it a second time.
const confirmSilent = async (
  options: WorkflowOptions,
  question: string,
): Promise<boolean> => {
  if (options.confirm) return options.confirm(question);
  if (options.noInput)
    throw new CliInvocationError(
      "this command requires interactive input; remove --no-input to answer the prompt",
    );
  if (options.prompt) return parseConfirmAnswer(await options.prompt(question));
  return terminalConfirm(options, question, true);
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

// Peer provisioning is optional: it must never abort a read this Device can
// already verify, and a peer that holds the current epoch grant is reused
// rather than re-provisioned. Grants are only written when the service
// confirms the actor holds the project-administration authority.
const wrapEpochKeyToPeers = async (
  options: WorkflowOptions,
  token: string,
  boundary: Boundary,
  deviceId: string,
  keys: DeviceKeyMaterial,
  epochKey: Uint8Array,
): Promise<readonly string[]> => {
  if (
    !keys.encryptionPublicKey ||
    !boundary.environment.projectId ||
    !boundary.environment.teamId
  )
    return [];
  const pending: string[] = [];
  for (const peer of boundary.peerDevices) {
    if (peer.id === deviceId) continue;
    if (peer.hasEpochGrant) continue;
    try {
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
    } catch {
      pending.push(
        `Device ${peer.id} is missing the Project epoch grant; an owner or admin can provision it by running dotrelay pull from their own Device`,
      );
    }
  }
  return Object.freeze(pending);
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
    // Deadline only: this mutation carries a fresh operation id, so it must
    // never be repeated automatically.
    response = await fetchWithDeadline(
      options.fetch ?? fetch,
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
      options.networkPolicy ?? defaultNetworkPolicy,
    );
  } catch (error) {
    if (error instanceof NetworkAttemptError)
      throw networkFailureCliError(
        error,
        "the Project grant endpoint",
        "grant_bootstrap_unavailable",
      );
    throw error;
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
    // Deadline only: an enrollment attempt names a pending operation, so a
    // stalled request is surfaced instead of being repeated.
    response = await fetchWithDeadline(
      options.fetch ?? fetch,
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
      options.networkPolicy ?? defaultNetworkPolicy,
    );
  } catch (error) {
    if (error instanceof NetworkAttemptError)
      throw networkFailureCliError(
        error,
        "the Device enrollment endpoint",
        "device_enrollment_unavailable",
      );
    throw error;
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

const rawPublicKey = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key));

const createDeviceAdmin = (
  options: WorkflowOptions,
  deviceId?: string,
): StrictJsonClient =>
  options.admin ??
  createStrictJsonClient(options.profile.pin, options.credentials, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
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
      ...(options.networkPolicy
        ? { networkPolicy: options.networkPolicy }
        : {}),
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

// A Device recovers the User's Account Master Key by exactly one of:
// unwrapping an active Recovery Code wrapper with a code entered on the
// Device (the wrapper object is service-visible; the code is never sent),
// or accepting an Account Key Transfer sealed to the Device's X25519 key by
// a trusted Device or browser. A passkey or encryption password still
// unlocks in a browser, which then hands the AMK to a CLI Device as a
// transfer. Once recovered, the AMK is stored in the Device's credential
// scope so the Device can open the Account Key Envelopes the service holds
// without any other Device.

const accountKeyScope = (options: WorkflowOptions, deviceId: string) =>
  Object.freeze({ pin: options.profile.pin, deviceId: uuidToBytes(deviceId) });

const loadAccountMasterKey = async (
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

type ActiveWrapper = Readonly<{
  readonly wrapperId: string;
  readonly type: "passkey-prf" | "password" | "recovery-code";
  readonly object: string;
  readonly creatorDeviceId?: string;
  readonly creatorPublicKey?: string;
}>;

const isActiveWrapper = (value: unknown): value is ActiveWrapper => {
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

const fetchActiveWrappers = async (
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
  const operationId = crypto.randomUUID();
  await authorized.admin.post(
    "/api/v1/account-keys/wrappers",
    {
      operationId,
      objectId: crypto.randomUUID(),
      object: base64(encodeProtocolObject(wrapper.object)),
      wrapperId: bytesToHex(wrapper.wrapperId),
      identityGeneration: String(authorized.bundle.userIdentityGeneration),
      ciphertextHash: sha384ToHex(await sha384(wrapper.ciphertext)),
      ciphertextLength: wrapper.ciphertext.length,
    },
    ["wrapperId", "idempotent"],
    { idempotencyKey: operationId },
  );
  return {
    recoveryCode: encodeRecoveryCode(recoveryCode),
    wrapperId: bytesToHex(wrapper.wrapperId),
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
const readRecoveryCode = async (
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
const accountKeyTransferValidityMs = 5 * 60 * 1000;

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
  const existing = await loadAccountMasterKey(options, authorized.deviceId);
  if (existing)
    return {
      deviceId: authorized.deviceId,
      message:
        "this Device already holds the Account Master Key; nothing to set up",
    };
  // The AMK is never stored by the service; active wrappers are the only
  // durable proof that one exists. Any active wrapper means another Device
  // or browser already established the AMK, so this one must recover it
  // rather than mint a second, incompatible key.
  const wrappers = await fetchActiveWrappers(authorized.admin);
  if (wrappers.length > 0)
    throw new CliError(
      "conflict",
      "this account already has an Account Master Key; run dotrelay device recover to take it over from an existing Device",
      {},
      "account_key_already_exists",
    );
  const accountMasterKey = generateAccountMasterKey();
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
  const operationId = crypto.randomUUID();
  await authorized.admin.post(
    "/api/v1/account-keys/wrappers",
    {
      operationId,
      objectId: crypto.randomUUID(),
      object: base64(encodeProtocolObject(wrapper.object)),
      wrapperId: bytesToHex(wrapper.wrapperId),
      identityGeneration: String(authorized.bundle.userIdentityGeneration),
      ciphertextHash: sha384ToHex(await sha384(wrapper.ciphertext)),
      ciphertextLength: wrapper.ciphertext.length,
    },
    ["wrapperId", "idempotent"],
    { idempotencyKey: operationId },
  );
  await storage.saveAccountKey(
    accountKeyScope(options, authorized.deviceId),
    accountMasterKey,
  );
  return {
    deviceId: authorized.deviceId,
    recoveryCode: encodeRecoveryCode(recoveryCode),
    wrapperId: bytesToHex(wrapper.wrapperId),
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

const opaqueEnvironmentId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The reference is an opaque Environment id or the operator-visible label;
// a label is resolved to the stable id before the workspace boundary is
// requested, because the service only resolves opaque ids.
const resolveRequestedEnvironmentReference = (
  parsed: ParsedArguments,
  localContext: Readonly<{ readonly environmentId?: string }> | null,
): string | undefined => {
  const positional =
    parsed.command === "init" ? parsed.positionals[0] : undefined;
  if (positional) return positional;
  if (parsed.environment) return parsed.environment;
  return localContext?.environmentId;
};

const adminClient = (options: WorkflowOptions): StrictJsonClient =>
  options.admin ??
  createStrictJsonClient(options.profile.pin, options.credentials, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
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
  let requestedEnvironment =
    options.environmentId ??
    resolveRequestedEnvironmentReference(parsed, localContext);
  if (
    requestedEnvironment !== undefined &&
    !opaqueEnvironmentId.test(requestedEnvironment)
  ) {
    const projectId = localContext?.projectId;
    if (projectId === undefined)
      throw new CliInvocationError(
        "the Environment reference could not be resolved to a stable id; run dotrelay project link to record the Project",
      );
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
    pendingActions,
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
      ...pendingActionsField(synced.workflow.pendingActions),
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
    const output = options.terminal?.output ?? process.stderr;
    const environment = destination.environment;
    if (mutation === "ROLLBACK") {
      // The rollback review names the append-only consequence: the operator
      // approves adding a Rollback Revision, not rewriting earlier ones.
      const frame = reviewFrame({
        title: `Review — roll back in ${environment}`,
        danger: true,
        body: reviewBody(changes, destination, parsed.reveal, [
          `  ${paint(ROLLBACK_NOTE, "faint")}`,
        ]),
        question: rollbackConfirmQuestion(),
      });
      output.write(`${frame}\n`);
      if (!(await confirmSilent(options, rollbackConfirmQuestion())))
        throw new CliInvocationError("rollback confirmation was declined");
    } else {
      const frame = reviewFrame({
        title: `Review — publish to ${environment}`,
        body: reviewBody(changes, destination, parsed.reveal),
        question: publicationConfirmQuestion(),
      });
      output.write(`${frame}\n`);
      if (!(await confirmSilent(options, publicationConfirmQuestion())))
        throw new CliInvocationError("publication confirmation was declined");
    }
  }
  const progress: Progress = createProgress({
    output: options.terminal?.output ?? process.stderr,
    live: (options.terminal?.output as { isTTY?: boolean })?.isTTY === true,
    quiet: options.noInput || parsed.json,
  });
  progress.start("Encrypting values");
  let artifacts: Awaited<ReturnType<typeof createPublicationArtifacts>>;
  try {
    artifacts = await createPublicationArtifacts(draftVariables, context);
    assertPublicationAccepted(reviewPublication(artifacts.commandBytes));
  } catch (error) {
    progress.fail("Encrypting values");
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
  const changedCount = draftVariables.filter(
    (variable) => variable.hasDraftChange,
  ).length;
  progress.done(
    `Encrypted ${changedCount} Variable${changedCount === 1 ? "" : "s"}`,
  );
  const operationId = crypto.randomUUID();
  progress.start("Uploading");
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
    progress.fail("Uploading");
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
  progress.done("Uploaded");
  if (!options.noInput && !parsed.json)
    stepDone(
      mutation === "ROLLBACK"
        ? "Rollback published"
        : `Published ${changedCount} Variable${changedCount === 1 ? "" : "s"}`,
    );
  return {
    revision: artifacts.request.revision.id,
    lanes: artifacts.encryptedLaneCount,
    tombstones: artifacts.tombstoneLaneCount,
    message: mutation === "ROLLBACK" ? "Rollback published" : "Published",
    ...pendingActionsField(synced.workflow.pendingActions),
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

const pendingActionsField = (
  actions: readonly string[],
): Readonly<Record<string, unknown>> =>
  actions.length > 0 ? { pendingActions: actions } : {};

// References a human or script can use instead of scraping internal ids:
// a Variable name (resolved against the live Manifest), a Variable id, a
// Revision id, or the ordinal the human history assigns to a Revision.
const UUID_REFERENCE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDINAL_REFERENCE = /^(?:#)?(\d+)$/;

const resolveRollbackTarget = (
  reference: string,
  page: SyncPageWire,
): string => {
  const trimmed = reference.trim();
  const ordinal = ORDINAL_REFERENCE.exec(trimmed);
  if (ordinal?.[1]) {
    const revision = page.revisions[Number.parseInt(ordinal[1], 10) - 1];
    if (!revision)
      throw new CliInvocationError(
        `Revision ${trimmed} is not in the verified history; this Environment holds ${page.revisions.length} Revision${page.revisions.length === 1 ? "" : "s"}`,
      );
    return revision.id;
  }
  if (UUID_REFERENCE.test(trimmed)) return trimmed;
  throw new CliInvocationError(
    `Rollback target ${trimmed} must be a Revision id or the ordinal dotrelay history shows for it`,
  );
};

const resolveVariableReferences = (
  references: readonly string[],
  variables: readonly DecodedVariable[],
): readonly string[] => {
  const live = variables.filter((variable) => !variable.tombstone);
  const liveNames = [...new Set(live.map((variable) => variable.name))].sort();
  const ids: string[] = [];
  for (const reference of references) {
    const trimmed = reference.trim();
    if (UUID_REFERENCE.test(trimmed)) {
      if (
        !live.some(
          (variable) => variable.id.toLowerCase() === trimmed.toLowerCase(),
        )
      )
        throw new CliInvocationError(
          `rollback Variable ${trimmed} is not part of the live Manifest`,
        );
      ids.push(trimmed.toLowerCase());
    } else {
      const matches = live.filter((variable) => variable.name === trimmed);
      if (matches.length === 0)
        throw new CliInvocationError(
          `unknown Variable ${trimmed}; the live Manifest holds ${liveNames.join(", ") || "no Variables"}`,
        );
      for (const variable of matches) ids.push(variable.id);
    }
  }
  return Object.freeze([...new Set(ids)]);
};

type RevisionHistoryChange = Readonly<{
  readonly kind: "added" | "removed" | "changed";
  readonly name: string;
  readonly ownership: "shared" | "user-defined";
  readonly valueChanged: boolean;
}>;

type RevisionHistoryRow = Readonly<{
  readonly ordinal: number;
  readonly revision: SyncRevisionWire;
  readonly current: boolean;
  readonly changes: readonly RevisionHistoryChange[];
}>;

// The revision object records which Variables the Revision touched (the
// client's changedVariableIdsFromRevision verifies those lane identities);
// the session's decoded snapshots show what each Variable looked like
// before and after. Together they are the change context this Device may
// render; Values themselves never enter history output.
const revisionHistoryRows = (
  page: SyncPageWire,
  snapshots: ReadonlyMap<string, readonly DecodedVariable[]>,
): readonly RevisionHistoryRow[] => {
  let previous: readonly DecodedVariable[] = [];
  const rows: RevisionHistoryRow[] = [];
  page.revisions.forEach((revision, index) => {
    const current = snapshots.get(revision.id) ?? [];
    const previousById = new Map(
      previous.map((variable) => [variable.id, variable]),
    );
    const currentById = new Map(
      current.map((variable) => [variable.id, variable]),
    );
    const changes: RevisionHistoryChange[] = [];
    for (const id of changedVariableIdsFromRevision(revision)) {
      const before = previousById.get(id);
      const after = currentById.get(id);
      if (!after) continue;
      const ownership = classificationFromOwnership(after.ownership);
      if (after.tombstone) {
        if (before && !before.tombstone)
          changes.push(
            Object.freeze({
              kind: "removed" as const,
              name: after.name,
              ownership,
              valueChanged: false,
            }),
          );
        continue;
      }
      if (!before || before.tombstone) {
        changes.push(
          Object.freeze({
            kind: "added" as const,
            name: after.name,
            ownership,
            valueChanged: false,
          }),
        );
        continue;
      }
      const valueChanged =
        before.value !== null &&
        after.value !== null &&
        before.value !== after.value;
      const definitionChanged =
        before.name !== after.name ||
        before.description !== after.description ||
        before.ownership !== after.ownership ||
        before.required !== after.required;
      if (valueChanged || definitionChanged)
        changes.push(
          Object.freeze({
            kind: "changed" as const,
            name: after.name,
            ownership,
            valueChanged,
          }),
        );
    }
    rows.push(
      Object.freeze({
        ordinal: index + 1,
        revision,
        current: page.currentHeadId === revision.id,
        changes: Object.freeze(changes),
      }),
    );
    previous = current;
  });
  return Object.freeze(rows);
};

const mutationLabel = (mutation: number): string =>
  mutation === 1
    ? "Genesis"
    : mutation === 2
      ? "Update"
      : mutation === 3
        ? "Rollback"
        : mutation === 4
          ? "Epoch transition"
          : mutation === 5
            ? "User-key rotation"
            : `Mutation ${mutation}`;

const mutationTone = (mutation: number): Tone =>
  mutation === 3 ? "warn" : mutation === 1 ? "accent" : "fg";

const revisionDate = (authoredAtMs: bigint): string => {
  const date = new Date(Number(authoredAtMs));
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
};

// Human history: enough readable context to tell the Revisions apart and to
// pick a Rollback target without decrypting anything, while `--json` keeps
// the documented revision metadata for automation.
const renderRevisionHistory = (
  environmentId: string,
  rows: readonly RevisionHistoryRow[],
): string => {
  const headingLine = heading("history");
  if (rows.length === 0)
    return [
      headingLine,
      `  ${paint("Environment", "faint")} ${paint(
        sanitizeCliText(environmentId),
        "muted",
      )}`,
      `  ${paint("No Revisions have been published yet.", "muted")}`,
      "",
    ].join("\n");
  const ordinalById = new Map(
    rows.map((row) => [row.revision.id, row.ordinal]),
  );
  const summaryFor = (row: RevisionHistoryRow): string => {
    let label = mutationLabel(row.revision.mutation);
    if (row.revision.rollbackTargetId) {
      const targetOrdinal = ordinalById.get(row.revision.rollbackTargetId);
      label += targetOrdinal
        ? ` of #${targetOrdinal}`
        : ` of ${row.revision.rollbackTargetId}`;
    }
    const changes = row.changes;
    if (changes.length > 0) {
      const counts = new Map<string, number>();
      for (const change of changes)
        counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
      const parts = [
        counts.get("added") ? `${counts.get("added")} added` : "",
        counts.get("changed") ? `${counts.get("changed")} changed` : "",
        counts.get("removed") ? `${counts.get("removed")} removed` : "",
      ].filter((part) => part.length > 0);
      label = parts.length > 0 ? `${parts.join(", ")} — ${label}` : label;
    }
    return label;
  };
  const lines: string[] = [
    headingLine,
    "",
    `  ${paint("Environment", "faint")} ${paint(
      sanitizeCliText(environmentId),
      "muted",
    )}`,
    "",
  ];
  for (const row of rows) {
    const marker = row.current ? paint("  current", "brand") : "         ";
    lines.push(
      `  ${paint(`#${row.ordinal}`, "muted")}  ${paint(
        revisionDate(row.revision.authoredAtMs),
        "fg",
      )}  ${paint(row.revision.id, "faint")}  ${paint(
        summaryFor(row),
        mutationTone(row.revision.mutation),
      )}${marker}`,
    );
    for (const change of row.changes) {
      const ownership = paint(change.ownership, "muted");
      if (change.kind === "added")
        lines.push(
          `     ${paint("+", "brand")}  ${paint(change.name, "fg")}  ${ownership}`,
        );
      else if (change.kind === "removed")
        lines.push(
          `     ${paint("-", "danger")}  ${paint(change.name, "fg")}  ${ownership}`,
        );
      else
        lines.push(
          `     ${paint("~", "warn")}  ${paint(change.name, "fg")}${
            change.valueChanged ? `  ${paint("value changed", "faint")}` : ""
          }`,
        );
    }
  }
  lines.push("");
  return lines.join("\n");
};

const renderSyncedHistory = (
  synced: Awaited<ReturnType<typeof syncWorkflow>>,
): string =>
  renderRevisionHistory(
    synced.page.environmentId,
    revisionHistoryRows(
      synced.page,
      synced.workflow.session.revisionSnapshots(),
    ),
  );

export const runProtectedWorkflow = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<Record<string, unknown> | { stdout: string }> => {
  if (parsed.command === "history") {
    const synced = await syncWorkflow(options, parsed);
    if (!parsed.json) return { stdout: renderSyncedHistory(synced) };
    return {
      revisions: synced.page.revisions.map((revision) => ({
        id: revision.id,
        mutation: revision.mutation,
        projectEpoch: revision.projectEpoch.toString(),
        authoredAtMs: revision.authoredAtMs.toString(),
        rollbackTargetId: revision.rollbackTargetId,
      })),
      ...pendingActionsField(synced.workflow.pendingActions),
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
    if (parsed.json)
      return {
        added,
        updated,
        removed,
        unchangedCount,
        ...pendingActionsField(synced.workflow.pendingActions),
      };
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
      const question = `Reveal ${entries.length} decrypted Values to stdout? [y/N]`;
      const frame = reviewFrame({
        title: `Review — reveal values to stdout`,
        danger: true,
        body: [
          kv(destinationRows(destination), 14),
          `  ${paint(
            "The decrypted Values will be printed to this terminal.",
            "faint",
          )}`,
        ].join("\n"),
        question,
      });
      (options.terminal?.output ?? process.stderr).write(`${frame}\n`);
      if (!(await confirmSilent(options, question)))
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
            ...pendingActionsField(synced.workflow.pendingActions),
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
          const question = pullConfirmQuestion(outputPath);
          const frame = reviewFrame({
            title: `Review — replace ${outputPath}`,
            danger: true,
            body: reviewBody(changes, destination, parsed.reveal, [
              `  ${paint(
                `The current file is retained at ${outputPath}.previous`,
                "faint",
              )}`,
            ]),
            question,
          });
          (options.terminal?.output ?? process.stderr).write(`${frame}\n`);
          if (!(await confirmSilent(options, question)))
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
      ? {
          stdout: contents,
          ...pendingActionsField(synced.workflow.pendingActions),
        }
      : {
          output: outputPath ?? "",
          ...(gitExclusion ? { gitExclusion } : {}),
          ...(replaceExisting ? { previous: `${outputPath}.previous` } : {}),
          ...pendingActionsField(synced.workflow.pendingActions),
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
      const { readStoredWorktreeContext, writeWorktreeContext } = await import(
        "./context"
      );
      // Preserve the explicit repository choice recorded for this worktree;
      // the selection was made against the current Git remotes before the
      // workflow started.
      const recorded = await readStoredWorktreeContext(options.contextPath);
      await writeWorktreeContext(options.contextPath, {
        ...(recorded ?? {}),
        serverProfileId: synced.workflow.publicationContext.serverProfileId,
        projectId: synced.workflow.publicationContext.projectId,
        environmentId: synced.workflow.createdEnvironmentId,
      });
    }
    return result;
  }
  if (parsed.command === "rollback") {
    const synced = await syncWorkflow(options, parsed);
    const terminalOutput = options.terminal?.output ?? process.stderr;
    // The target Revision comes from the command line or, interactively,
    // from the rendered history, so an operator never has to lift internal
    // ids out of a JSON dump; automation still passes them explicitly.
    let targetReference = (parsed.positionals[0] ?? "").trim();
    if (!targetReference && !options.noInput) {
      terminalOutput.write(renderSyncedHistory(synced));
      targetReference = (
        await ask(
          options,
          "Roll back to which Revision (ordinal, #ordinal, or Revision id)?",
        )
      ).trim();
    }
    if (!targetReference)
      throw new CliInvocationError("rollback requires a target Revision");
    const target = resolveRollbackTarget(targetReference, synced.page);
    const live = synced.variables.filter((variable) => !variable.tombstone);
    let references = parsed.variableReferences;
    if (references.length === 0 && !options.noInput) {
      const maxName = live.reduce(
        (width, variable) =>
          Math.max(width, visibleWidth(sanitizeCliText(variable.name))),
        0,
      );
      terminalOutput.write(
        [
          paint("Variables in the live Manifest:", "fg"),
          ...live.map(
            (variable) =>
              `  ${pad(sanitizeCliText(variable.name), maxName)}  ${paint(
                classificationFromOwnership(variable.ownership),
                "muted",
              )}`,
          ),
          "",
        ].join("\n"),
      );
      const answer = (
        await ask(
          options,
          'Variables to roll back (comma-separated names, or "all")?',
        )
      ).trim();
      references =
        answer === "all"
          ? live.map((variable) => variable.name)
          : answer
              .split(",")
              .map((name) => name.trim())
              .filter((name) => name.length > 0);
      // An answer of only separators names no Variable; refuse it instead
      // of silently publishing nothing.
      if (references.length === 0)
        throw new CliInvocationError("rollback requires at least one Variable");
    }
    const selectedIds = resolveVariableReferences(references, synced.variables);
    const selected = new Set(selectedIds);
    let targetValues: ReadonlyMap<string, string | null>;
    try {
      targetValues = await synced.workflow.session.resolveRollbackValues({
        targetRevision: target,
        selectedVariableIds: selectedIds,
      });
    } catch {
      throw new CliError(
        "conflict",
        "the target Revision is not available in verified history",
        {},
        "rollback_target_unavailable",
      );
    }
    const absentSelected = selectedIds.filter(
      (variableId) => !targetValues.has(variableId),
    );
    if (absentSelected.length > 0) {
      const names = absentSelected
        .map((variableId) => {
          const candidate = synced.variables.find(
            (variable) => variable.id === variableId,
          );
          return candidate ? candidate.name : variableId;
        })
        .join(", ");
      throw new CliError(
        "conflict",
        `${names} did not exist in the target Revision and cannot be rolled back`,
        {},
        "rollback_variable_absent",
      );
    }
    const variables = synced.variables.map((variable) =>
      selected.has(variable.id)
        ? Object.freeze({
            ...variable,
            value: targetValues.get(variable.id) ?? null,
          })
        : variable,
    );
    return publish(options, parsed, variables, "ROLLBACK", {
      target,
      ids: selectedIds,
    });
  }
  throw new CliInvocationError(
    "the protected workflow is not available for this command",
  );
};
