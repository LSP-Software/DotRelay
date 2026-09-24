import { readFile } from "node:fs/promises";
import {
  type AccountKeyTrustedKeys,
  type CliDeviceStorage,
  createCliDeviceStorage,
  type createVerifiedEnvironmentSession,
  type DeviceKeyMaterial,
  type DevicePrivateBundle,
  loadDeviceKeyMaterial,
  type ProtocolTransport,
  type PublicationContext,
  type RevisionSigningTrust,
  type RevisionSigningTrustEntry,
} from "@dotrelay/client";
import { sha384ToHex, uuidToBytes } from "@dotrelay/contracts";
import { createStrictJsonClient, type StrictJsonClient } from "./admin";
import type { ParsedArguments } from "./args";
import type { CredentialStore } from "./credentials";
import { describeCliClient } from "./device-describe";
import {
  createFileDeviceRecordStore,
  deviceMetadataPath,
  readDeviceId,
} from "./device-storage";
import { CliError, CliInvocationError } from "./errors";
import type { GitTrackingProbe } from "./git-tracking";
import type { NetworkPolicy } from "./network";
import { atomicWriteProtectedFile } from "./output";
import type { CliServerProfile, FetchFunction } from "./profile";
import { readTerminalLine, type TerminalIo } from "./terminal";
import {
  confirmAction,
  parseConfirmAnswer,
  UNREADABLE_TERMINAL_MESSAGE,
} from "./ui";
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

export type Boundary = Readonly<{
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
    readonly name?: string;
    readonly clientKind?: string;
    readonly osName?: string;
    readonly clientSummary?: string;
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
  readonly userValueKeyEnvelope?: string;
  readonly signingTrustKeys: readonly string[];
  readonly signingTrustDevices: readonly SigningTrustDevice[];
  readonly peerDevices: readonly Readonly<{
    readonly id: string;
    readonly encryptionPublicKey: string;
    readonly signingPublicKey: string;
    readonly hasEpochGrant: boolean;
    readonly name?: string;
    readonly clientKind?: string;
    readonly osName?: string;
    readonly clientSummary?: string;
  }>[];
}>;

export type SigningTrustDevice = Readonly<{
  readonly deviceId: string;
  readonly userId: string;
  readonly signingPublicKey: string;
  readonly deviceActiveFromMs: number | null;
  readonly deviceActiveUntilMs: number | null;
  readonly memberSinceMs: number | null;
  readonly memberUntilMs: number | null;
}>;

export type WorkflowSession = Readonly<{
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const requiredString = (value: unknown, label: string): string => {
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
  "userValueKeyEnvelope",
  "peerDevices",
] as const;

export const parseBoundary = (value: Record<string, unknown>): Boundary => {
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
      ...(typeof device.name === "string" ? { name: device.name } : {}),
      ...(typeof device.clientKind === "string"
        ? { clientKind: device.clientKind }
        : {}),
      ...(typeof device.osName === "string" ? { osName: device.osName } : {}),
      ...(typeof device.clientSummary === "string"
        ? { clientSummary: device.clientSummary }
        : {}),
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
    ...(typeof value.userValueKeyEnvelope === "string"
      ? { userValueKeyEnvelope: value.userValueKeyEnvelope }
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
              ...(typeof entry.name === "string" ? { name: entry.name } : {}),
              ...(typeof entry.clientKind === "string"
                ? { clientKind: entry.clientKind }
                : {}),
              ...(typeof entry.osName === "string"
                ? { osName: entry.osName }
                : {}),
              ...(typeof entry.clientSummary === "string"
                ? { clientSummary: entry.clientSummary }
                : {}),
            },
          ];
        })
      : [],
  });
};

export const zeros = (length: number): Uint8Array => new Uint8Array(length);

export const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const hexToBytes = (value: string): Uint8Array => {
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

export const collectSigningTrust = (
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
// A creatorPublicKey from an API response is not added unless
// authenticatedCreatorKeys has already found that key in this history.
export const accountKeyTrustedKeys = (
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

export const statePath = (directory: string, environmentId: string): string =>
  `${directory}/head-${environmentId}.json`;

export const readTrustedHead = async (
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

export const safeProjectEpoch = (value: unknown): number => {
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

export const writeTrustedHead = async (
  path: string,
  id: string,
  hash: Uint8Array,
): Promise<void> => {
  await atomicWriteProtectedFile(
    path,
    `${JSON.stringify({ id, hash: sha384ToHex(hash) })}\n`,
  );
};

export const ask = async (
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
export const terminalConfirm = async (
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
    throw new CliInvocationError(UNREADABLE_TERMINAL_MESSAGE);
  }
};

// The review frame has already printed the question, so the terminal read
// must not echo it a second time.
export const confirmSilent = async (
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

export const resolveDeviceStorage = (
  options: WorkflowOptions,
): CliDeviceStorage =>
  options.deviceStorage ??
  createCliDeviceStorage(options.profile.pin, options.credentials, {
    recordStore: createFileDeviceRecordStore(options.stateDirectory),
  });

export const responseJson = async (
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

export type AuthorizedDevice = Readonly<{
  readonly admin: StrictJsonClient;
  readonly boundary: Boundary;
  readonly userId: string;
  readonly deviceId: string;
  readonly bundle: DevicePrivateBundle;
  readonly keys: DeviceKeyMaterial;
}>;

export const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

export const fromBase64 = (value: unknown, label: string): Uint8Array => {
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

export const rawPublicKey = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key));

export const createDeviceAdmin = (
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

export const verifyDeviceBundle = async (
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

export const loadAuthorizedDevice = async (
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
  // Best-effort display-name refresh: a hostname change or a first run
  // after this feature ships is recorded without blocking the workflow.
  // Failures are ignored — the boundary still loads with the stored name.
  await admin
    .post(
      "/api/v1/devices/self",
      (() => {
        const client = describeCliClient();
        return {
          client: {
            displayName: client.displayName,
            clientKind: client.clientKind,
            ...(client.osName ? { osName: client.osName } : {}),
            ...(client.clientSummary
              ? { clientSummary: client.clientSummary }
              : {}),
          },
        };
      })(),
      ["name", "clientKind", "osName", "clientSummary", "nameOverridden"],
    )
    .catch(() => undefined);
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

export const opaqueEnvironmentId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The reference is an opaque Environment id or the operator-visible label;
// a label is resolved to the stable id before the workspace boundary is
// requested, because the service only resolves opaque ids.
export const resolveRequestedEnvironmentReference = (
  parsed: ParsedArguments,
  localContext: Readonly<{ readonly environmentId?: string }> | null,
): string | undefined => {
  const positional =
    parsed.command === "init" ? parsed.positionals[0] : undefined;
  if (positional) return positional;
  if (parsed.environment) return parsed.environment;
  return localContext?.environmentId;
};

export const adminClient = (options: WorkflowOptions): StrictJsonClient =>
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
