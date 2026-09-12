import { dirname, isAbsolute, resolve } from "node:path";
import {
  type CliDeviceStorage,
  createCliDeviceStorage,
  type DeviceKeyMaterial,
  loadDeviceKeyMaterial,
} from "@dotrelay/client";
import { uuidToBytes } from "@dotrelay/contracts";
import {
  createStrictJsonClient,
  findProjectByRepository,
  linkProject,
  listEnvironments,
  listTeams,
  type ProjectSummary,
  resolveEnvironmentForProject,
  resolveTeamForProject,
  type StrictJsonClient,
  selectEnvironment,
  type TeamSummary,
} from "./admin";
import {
  type ParsedArguments,
  parseArguments,
  rejectForbiddenFlags,
} from "./args";
import {
  browserOpenFailure,
  createSessionStore,
  loginWithDeviceAuthorization,
  openVerificationPage,
} from "./auth";
import {
  detectGitHubRepository,
  type GitRemote,
  readWorktreeContext,
  resolveEnvironmentSelection,
  resolveGitHubRepository,
  type WorktreeContext,
  worktreeConfigPath,
  writeWorktreeContext,
} from "./context";
import {
  createNativeCredentialStore,
  type NativeCredentialStore,
} from "./credentials";
import {
  createFileDeviceRecordStore,
  deviceMetadataPath,
  readDeviceId,
} from "./device-storage";
import {
  CliError,
  CliInvocationError,
  diagnosticForError,
  EXIT_CODES,
  humanDetailForError,
  sanitizeCliText,
} from "./errors";
import { createGitTrackingProbe, type GitTrackingProbe } from "./git-tracking";
import {
  addServerProfile,
  type CliServerProfile,
  createFileProfileCatalog,
  type FetchFunction,
  profileCatalogPath,
  resolveServerProfile,
  useServerProfile,
} from "./profile";
import type { TerminalIo } from "./terminal";
import {
  paint,
  renderStep,
  rewriteRegion,
  selectOption,
  writeNotice,
} from "./ui";
import {
  approveDeviceEnrollment,
  beginDeviceEnrollment,
  completeDeviceEnrollment,
  createRecoveryBackup,
  enrollDevice,
  enrollFirstDevice,
  restoreRecoveryKit,
  runProtectedWorkflow,
  workspaceBoundaryFields,
} from "./workflow";

export type { TerminalIo };

export const version = "0.0.0-foundation";

export const renderHelp = (): string => {
  return [
    "Usage: dotrelay <command>",
    "",
    "  setup <origin>   Trust this Server Profile, sign in, enroll this machine",
    "  login            Sign in and enroll this machine",
    "  init             Publish this repo's .env for the first time",
    "  push             Publish changes from .env",
    "  pull             Write decrypted Values to .env",
    "  diff             Compare .env with the Environment",
    "  status           Show this machine's connection",
    "",
    "More commands: dotrelay help",
    "Automation: --json  --no-input  --force  --debug",
  ].join("\n");
};

export const renderPowerHelp = (): string => {
  return [
    "Usage: dotrelay <command>",
    "",
    "Everyday:",
    "  setup <origin>   Trust this Server Profile, sign in, enroll this machine",
    "  login            Sign in and enroll this machine",
    "  init             Publish this repo's .env for the first time",
    "  push             Publish changes from .env",
    "  pull             Write decrypted Values to .env",
    "  diff             Compare .env with the Environment",
    "  status           Show this machine's connection",
    "",
    "Power:",
    "  profile add <name> <origin>   Trust and save a Server Profile",
    "  profile use <name>            Select the global Server Profile",
    "  profile list                  List saved Server Profiles",
    "  logout                        Remove the local session",
    "  device enroll                 Bootstrap or begin Device enrollment",
    "  device begin --output <file>  Begin dual-control enrollment",
    "  device approve --from <file>  Approve an enrollment handoff",
    "  device complete --from <file> Complete an approved enrollment",
    "  device backup --output <file> Create a Recovery Kit",
    "  device recover --from <file>  Restore a Device from a Recovery Kit",
    "  context                       Detect the GitHub Repository",
    "  project link --team <team>    Link a Project explicitly",
    "  env use <environment-id>      Select an Environment by opaque id",
    "  history                       List verified Revision metadata",
    "  rollback <revision>           Append a lane-scoped Rollback",
    "",
    "Shared: --profile  --environment  --team <id>  --json  --debug  --no-input",
    "(each is scoped to the commands that consume it; unsupported options, unexpected positionals, and conflicting output flags are rejected before work starts)",
    "Publish: --classify NAME=shared|user-defined  --from <file>  --force",
    "Pull: --output <file>  --stdout  --reveal  --force",
    "Diff: --from <file>  --reveal",
    "Pull checks the output's Git tracking state before writing: untracked outputs get a repository-local exclusion (.git/info/exclude), and a Git-tracked output is refused — untrack it (git rm --cached <path>) or choose another --output path.",
    "Change previews show names, ownership, and change type only; --reveal shows plaintext Values for that one review, never in JSON or diagnostics.",
    "Profile trust: setup and profile add accept --accept-profile <id> under --no-input.",
    "Destructive approval: --force is the only way to approve, under --no-input, replacing a differing pull output file, publishing removed Variables, or rotating an existing Recovery Kit.",
    "Values are never diagnostic data. --insecure and credential flags are not supported.",
  ].join("\n");
};

export const main = (args: string[]): string => {
  rejectForbiddenFlags(args);
  if (args.includes("--version")) return version;
  return renderHelp();
};

export type CliRuntime = Readonly<{
  readonly profilePath?: string;
  readonly credentials?: NativeCredentialStore;
  readonly fetch?: FetchFunction;
  readonly githubFetch?: FetchFunction;
  readonly deviceId?: string;
  readonly open?: (url: string) => Promise<void>;
  readonly readGitRemotes?: () => Promise<readonly GitRemote[]>;
  readonly worktreeConfig?: string;
  readonly admin?: StrictJsonClient;
  readonly stdoutIsTerminal?: boolean;
  readonly prompt?: (question: string) => Promise<string>;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly terminal?: TerminalIo;
  readonly deviceStorage?: CliDeviceStorage;
  readonly stateDirectory?: string;
  readonly gitTrackingProbe?: GitTrackingProbe;
}>;

export type CliRunResult = Readonly<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

const readGitRemotes = async (): Promise<readonly GitRemote[]> => {
  try {
    const child = Bun.spawn(
      ["git", "config", "--get-regexp", "^remote\\..*\\.url$"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (exitCode !== 0 && exitCode !== 1) throw new Error("git config failed");
    return Object.freeze(
      stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const separator = line.indexOf(" ");
          return Object.freeze({
            name: line.slice("remote.".length, separator).replace(/\.url$/, ""),
            url: line.slice(separator + 1),
          });
        }),
    );
  } catch {
    throw new CliError(
      "local-io",
      "could not read Git remotes",
      {},
      "repository_detection_failed",
    );
  }
};

const defaultWorktreeConfigPath = async (): Promise<string> => {
  try {
    const child = Bun.spawn(["git", "rev-parse", "--git-dir"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [directory, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error("git directory unavailable");
    const gitDirectory = directory.trim();
    if (!gitDirectory) throw new Error("git directory unavailable");
    return worktreeConfigPath(
      isAbsolute(gitDirectory) ? gitDirectory : resolve(gitDirectory),
    );
  } catch {
    throw new CliInvocationError("could not locate the Git worktree context");
  }
};

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

// Stored-local state is labelled as such; only the service-verified lines
// may claim a session or Device as current.
const statusSessionLine = (session: string): string => {
  if (session === "verified") return "Signed in (verified)";
  if (session === "expired") return "Session expired or revoked";
  if (session === "unverified") return "Signed in (last known; not verified)";
  return "Not signed in";
};

const statusDeviceLine = (device: string): string => {
  if (device === "active") return "Device active (verified)";
  if (device === "not-active") return "Device not active on the Server Profile";
  if (device === "unusable") return "Device keys are not usable locally";
  if (device === "unverified") return "Device (last known; not verified)";
  return "No Device";
};

// The note names the stage that could not complete; once the service has
// answered one probe it must never be reported as unreachable.
const statusServiceNote = (service: string, session: string): string | null => {
  if (service === "offline")
    return session === "verified"
      ? "Offline: the Device check could not be completed"
      : "Offline: could not reach the Server Profile";
  if (service === "unavailable")
    return session === "verified"
      ? "The Server Profile could not complete the Device check"
      : "The Server Profile could not be verified";
  return null;
};

const renderStatusCard = (value: Record<string, unknown>): string => {
  const profile =
    typeof value.profile === "string" ? value.profile : "No Server Profile";
  const session =
    typeof value.session === "string" ? value.session : "not-stored";
  const device =
    typeof value.device === "string" ? value.device : "not-enrolled";
  const service = typeof value.service === "string" ? value.service : "skipped";
  const lines: string[] = [
    `  ${paint("·", "wax")}  ${paint(profile, "paper")}`,
  ];
  if (typeof value.origin === "string")
    lines.push(`     ${paint(value.origin, "graphite")}`);
  lines.push(
    `     ${paint(
      statusSessionLine(session),
      session === "verified" ? "ok" : "dim",
    )}`,
  );
  lines.push(
    `     ${paint(
      statusDeviceLine(device),
      device === "active" ? "ok" : "dim",
    )}`,
  );
  const note = statusServiceNote(service, session);
  if (note) lines.push(`     ${paint(note, "wax")}`);
  if (typeof value.projectId === "string")
    lines.push(`     ${paint(`Project ${value.projectId}`, "graphite")}`);
  const environment =
    typeof value.environment === "string"
      ? value.environment
      : typeof value.environmentId === "string"
        ? value.environmentId
        : null;
  if (environment) {
    const marker =
      value.environmentActive === false
        ? " (not active)"
        : value.environmentUnverified === true
          ? " (not verified)"
          : "";
    lines.push(
      `     ${paint(
        `Environment ${environment}${marker}`,
        value.environmentActive === false ||
          value.environmentUnverified === true
          ? "dim"
          : "graphite",
      )}`,
    );
  }
  const next = typeof value.nextAction === "string" ? value.nextAction : "none";
  lines.push(`     ${paint(`Next: ${next}`, "dim")}`);
  lines.push("");
  return lines.join("\n");
};

const renderSuccess = (
  parsed: ParsedArguments,
  value: Record<string, unknown>,
): string => {
  if (parsed.json) return json({ ok: true, ...value });
  if (parsed.command === "status") return renderStatusCard(value);
  if (typeof value.message === "string")
    return `${sanitizeCliText(value.message)}\n`;
  return `${Object.entries(value)
    .map(([key, entry]) => {
      const rendered =
        typeof entry === "string"
          ? entry
          : entry !== null && typeof entry === "object"
            ? JSON.stringify(entry)
            : String(entry);
      return `${sanitizeCliText(key)}: ${sanitizeCliText(rendered ?? "")}`;
    })
    .join("\n")}\n`;
};

const profileNameFromOrigin = (origin: string): string => {
  let host = "default";
  try {
    host = new URL(origin).hostname;
  } catch {
    throw new CliInvocationError(
      "Server Profile origin must be an absolute URL",
    );
  }
  const normalized = host
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)
    ? normalized
    : "default";
};

const confirmProfileTrust = async (
  parsed: ParsedArguments,
  runtime: CliRuntime,
  candidate: Readonly<{
    readonly origin: string;
    readonly pin: { readonly serverProfileId: string };
  }>,
): Promise<boolean> => {
  if (parsed.acceptProfile === candidate.pin.serverProfileId) return true;
  if (parsed.noInput) return false;
  const output = runtime.terminal?.output ?? process.stderr;
  output.write(
    renderStep("Trust this Server Profile?", [
      candidate.origin,
      candidate.pin.serverProfileId,
    ]),
  );
  if (runtime.confirm) return runtime.confirm(`Trust ${candidate.origin}?`);
  const { readTerminalLine } = await import("./terminal");
  const answer = runtime.prompt
    ? await runtime.prompt(`Trust ${candidate.origin}? [Y/n]`)
    : await readTerminalLine(
        `Trust ${candidate.origin}? [Y/n]`,
        runtime.terminal,
      );
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "" || trimmed === "y" || trimmed === "yes";
};

const deviceWorkflowOptions = (
  parsed: ParsedArguments,
  runtime: CliRuntime,
  profile: Awaited<ReturnType<typeof resolveServerProfile>>,
  credentials: NativeCredentialStore,
) => {
  const stateDirectory =
    runtime.stateDirectory ??
    dirname(runtime.profilePath ?? profileCatalogPath());
  return {
    profile,
    credentials,
    ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
    ...(runtime.deviceStorage ? { deviceStorage: runtime.deviceStorage } : {}),
    ...(runtime.admin ? { admin: runtime.admin } : {}),
    ...(runtime.deviceId ? { deviceId: runtime.deviceId } : {}),
    stateDirectory,
    contextPath: runtime.worktreeConfig ?? "",
    ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
    ...(runtime.confirm ? { confirm: runtime.confirm } : {}),
    ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
    noInput: parsed.noInput,
    force: parsed.force,
    stdoutIsTerminal: runtime.stdoutIsTerminal ?? false,
  };
};

const requireEnrolledDevice = (deviceId: string | null): string => {
  if (deviceId) return deviceId;
  throw new CliError(
    "authentication",
    "no Device is enrolled for this Server Profile; run dotrelay login or dotrelay device enroll",
    {},
    "device_bundle_missing",
  );
};

const createAdminClient = async (
  runtime: CliRuntime,
  profile: Awaited<ReturnType<typeof resolveServerProfile>>,
  credentials: NativeCredentialStore,
): Promise<StrictJsonClient> => {
  if (runtime.admin) return runtime.admin;
  const stateDirectory =
    runtime.stateDirectory ??
    dirname(runtime.profilePath ?? profileCatalogPath());
  const deviceId = requireEnrolledDevice(
    runtime.deviceId ??
      (await readDeviceId(deviceMetadataPath(stateDirectory, profile.pin))),
  );
  return createStrictJsonClient(profile.pin, credentials, {
    deviceId,
    ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
  });
};

const describeExpiry = (seconds: number): string => {
  if (seconds % 60 === 0) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
};

const loginAndEnroll = async (
  parsed: ParsedArguments,
  runtime: CliRuntime,
  profile: Awaited<ReturnType<typeof resolveServerProfile>>,
): Promise<Record<string, unknown>> => {
  const credentials = runtime.credentials ?? createNativeCredentialStore();
  const output = runtime.terminal?.output ?? process.stderr;
  const opensBrowser = !(parsed.noOpen || parsed.noInput);
  let manualPath = !opensBrowser;
  let openFailed = false;
  let waitingBody: readonly string[] = [];
  let waitLines = 0;
  const renderWaiting = (): void => {
    const body = openFailed
      ? [
          ...waitingBody,
          "",
          "Could not open a browser automatically; open the URL above in any browser.",
        ]
      : waitingBody;
    waitLines = rewriteRegion(
      output,
      waitLines,
      renderStep(
        "Allow this CLI?",
        body,
        manualPath
          ? "Open the URL above to complete sign-in"
          : "Waiting for the browser",
      ),
    );
  };
  const login = await loginWithDeviceAuthorization(
    profile.pin,
    createSessionStore(credentials),
    {
      noOpen: parsed.noOpen || parsed.noInput,
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      open: runtime.open ?? openVerificationPage,
      onAuthorization: (authorization, verificationUrl) => {
        if (parsed.json) {
          output.write(
            json({
              ok: true,
              event: "device_authorization",
              userCode: authorization.userCode,
              verificationUri: verificationUrl,
              intervalSeconds: authorization.intervalSeconds,
              expiresInSeconds: authorization.expiresInSeconds,
            }),
          );
          return;
        }
        waitingBody = [
          verificationUrl,
          `Code: ${authorization.userCode}`,
          `Expires in ${describeExpiry(authorization.expiresInSeconds)}`,
        ];
        renderWaiting();
      },
      onOpenFailed: () => {
        if (parsed.json) {
          output.write(
            json(
              diagnosticForError(
                browserOpenFailure(
                  "could not open the verification page in a browser; open the URL from the authorization event",
                ),
              ),
            ),
          );
          return;
        }
        manualPath = true;
        openFailed = true;
        renderWaiting();
      },
    },
  );
  if (!parsed.json) {
    waitLines = rewriteRegion(output, waitLines, "");
    writeNotice(output, "Signed in");
  }
  const enrollment = await enrollFirstDevice(
    deviceWorkflowOptions(parsed, runtime, profile, credentials),
  );
  if (!parsed.json)
    writeNotice(
      output,
      enrollment.existing ? "Device already enrolled" : "Device enrolled",
    );
  return {
    profile: profile.name,
    userCode: login.userCode,
    verificationUri: login.verificationUri,
    deviceId: enrollment.deviceId,
    device: enrollment.active ? "enrolled" : "not enrolled",
    message: enrollment.existing
      ? "Signed in. Device already enrolled."
      : "Signed in. Device enrolled.",
  };
};

const isAuthenticationRequired = (error: unknown): boolean =>
  error instanceof CliError && error.code === "authentication_required";

const isServiceUnreachable = (error: unknown): boolean =>
  error instanceof CliError && error.code === "service_unavailable";

// Verifies what this installation claims: the stored session against the
// service, the stored Device id against the service's active Device, and the
// local key bundle against the keys the service registered. The result
// separates stored-local truth from service-verified truth and names the
// next repair; a failure to reach or hear back from the service never
// upgrades a stored state into a verified one.
const verifyStatus = async (
  runtime: CliRuntime,
  selected: CliServerProfile,
): Promise<Record<string, unknown>> => {
  const credentials = runtime.credentials ?? createNativeCredentialStore();
  const stateDirectory =
    runtime.stateDirectory ??
    dirname(runtime.profilePath ?? profileCatalogPath());
  const pin = selected.pin;
  const sessionToken = await createSessionStore(credentials).get(pin);
  const storedDeviceId =
    runtime.deviceId ??
    (await readDeviceId(deviceMetadataPath(stateDirectory, pin)));
  // Local truth: can this installation load its Device keys? The bundle is
  // wrapped by a per-Device secret, so a missing or damaged record or
  // wrapping key surfaces here instead of mid-workflow.
  let deviceKeys: DeviceKeyMaterial | null = null;
  if (storedDeviceId) {
    const deviceStorage =
      runtime.deviceStorage ??
      createCliDeviceStorage(pin, credentials, {
        recordStore: createFileDeviceRecordStore(stateDirectory),
      });
    try {
      deviceKeys = await loadDeviceKeyMaterial(
        await deviceStorage.load({
          pin,
          deviceId: uuidToBytes(storedDeviceId),
        }),
      );
    } catch {
      deviceKeys = null;
    }
  }
  const deviceKeysUsable =
    deviceKeys !== null &&
    deviceKeys.encryptionPublicKey !== undefined &&
    deviceKeys.signingPublicKey !== undefined;
  let worktreeContext: WorktreeContext | null = null;
  try {
    worktreeContext = await readWorktreeContext(
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath()),
    );
  } catch {
    worktreeContext = null;
  }
  // Only this profile's selection describes this machine.
  const context =
    worktreeContext && worktreeContext.serverProfileId === pin.serverProfileId
      ? worktreeContext
      : null;
  // The boundary endpoint scopes to the selected Environment only when its
  // stored id is a UUID it can resolve; anything else is reported as stored,
  // without a service claim.
  const contextEnvironmentId = context?.environmentId;
  const queriedEnvironment =
    contextEnvironmentId !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      contextEnvironmentId,
    );
  const environmentQuery =
    queriedEnvironment && contextEnvironmentId
      ? `?environment=${encodeURIComponent(contextEnvironmentId)}`
      : "";
  let sessionState: "verified" | "expired" | "unverified" | "not-stored" =
    sessionToken ? "unverified" : "not-stored";
  let deviceState:
    | "active"
    | "not-active"
    | "unusable"
    | "unverified"
    | "not-enrolled" = storedDeviceId
    ? deviceKeysUsable
      ? "unverified"
      : "unusable"
    : "not-enrolled";
  let service: "verified" | "offline" | "rejected" | "unavailable" | "skipped" =
    sessionToken ? "offline" : "skipped";
  let environmentLabel: string | null = null;
  let environmentActive: boolean | null = null;
  let environmentUnverified = false;
  if (sessionToken) {
    const admin =
      runtime.admin ??
      createStrictJsonClient(pin, credentials, {
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        ...(storedDeviceId ? { deviceId: storedDeviceId } : {}),
      });
    try {
      await admin.get("/api/v1/session", ["authenticated", "user"]);
      sessionState = "verified";
      service = "verified";
    } catch (error) {
      if (isAuthenticationRequired(error)) {
        sessionState = "expired";
        service = "rejected";
      } else {
        // An answered-but-unreadable service (a failed or malformed
        // response) is reported separately from an unreachable one; both
        // leave the session unverified.
        sessionState = "unverified";
        service = isServiceUnreachable(error) ? "offline" : "unavailable";
      }
    }
    if (sessionState === "verified" && storedDeviceId) {
      try {
        const boundary = await admin.get(
          `/api/v1/workspace/boundary${environmentQuery}`,
          workspaceBoundaryFields,
        );
        const boundaryDevice = boundary.device;
        const deviceRecord =
          boundaryDevice !== null &&
          typeof boundaryDevice === "object" &&
          !Array.isArray(boundaryDevice)
            ? (boundaryDevice as Record<string, unknown>)
            : null;
        const deviceActive =
          deviceRecord !== null &&
          deviceRecord.active === true &&
          deviceRecord.id === storedDeviceId;
        if (!deviceActive) {
          deviceState = "not-active";
          service = "rejected";
        } else {
          // The registered keys are the service's word on which keys this
          // Device holds; a bundle that no longer matches cannot be
          // trusted, even though it loads.
          let keysMatch = deviceKeysUsable;
          if (keysMatch && deviceKeys) {
            const matches = async (
              local: CryptoKey | undefined,
              registered: unknown,
            ): Promise<boolean> => {
              if (local === undefined || typeof registered !== "string")
                return true;
              const raw = new Uint8Array(
                await crypto.subtle.exportKey("raw", local),
              );
              const hex = [...raw]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
              return hex === registered.toLowerCase();
            };
            keysMatch =
              (await matches(
                deviceKeys.encryptionPublicKey,
                deviceRecord?.encryptionPublicKey,
              )) &&
              (await matches(
                deviceKeys.signingPublicKey,
                deviceRecord?.signingPublicKey,
              ));
          }
          // A bundle that fails to load or match is a local fault: the
          // service accepted this Device, so the service state stays
          // verified while the Device line reports the local break.
          deviceState = keysMatch ? "active" : "unusable";
        }
        if (queriedEnvironment && context) {
          const boundaryEnvironment = boundary.environment;
          const environmentRecord =
            boundaryEnvironment !== null &&
            typeof boundaryEnvironment === "object" &&
            !Array.isArray(boundaryEnvironment)
              ? (boundaryEnvironment as Record<string, unknown>)
              : null;
          if (
            environmentRecord !== null &&
            environmentRecord.id === context.environmentId
          ) {
            environmentActive = true;
            environmentLabel =
              typeof environmentRecord.label === "string" &&
              environmentRecord.label.trim().length > 0
                ? environmentRecord.label.trim()
                : null;
          } else {
            environmentActive = false;
          }
        }
      } catch (error) {
        if (isAuthenticationRequired(error)) {
          sessionState = "expired";
          service = "rejected";
        } else {
          service = isServiceUnreachable(error) ? "offline" : "unavailable";
        }
        deviceState = deviceKeysUsable ? "unverified" : "unusable";
      }
    }
    if (
      sessionState === "verified" &&
      contextEnvironmentId !== undefined &&
      !queriedEnvironment
    )
      environmentUnverified = true;
  }
  const nextAction =
    sessionState === "not-stored" || sessionState === "expired"
      ? "run dotrelay login"
      : deviceState === "unusable"
        ? "run dotrelay device recover"
        : deviceState === "not-active" ||
            (deviceState === "not-enrolled" && sessionState === "verified")
          ? "run dotrelay device enroll"
          : environmentActive === false
            ? "run dotrelay env use <environment-id>"
            : service === "offline"
              ? "retry when the Server Profile is reachable"
              : service !== "verified"
                ? "retry dotrelay status"
                : "none";
  return {
    profile: selected.name,
    origin: selected.origin,
    service,
    session: sessionState,
    device: deviceState,
    nextAction,
    ...(context ? { projectId: context.projectId } : {}),
    ...(contextEnvironmentId
      ? {
          environmentId: contextEnvironmentId,
          ...(environmentLabel ? { environment: environmentLabel } : {}),
        }
      : {}),
    ...(environmentActive !== null ? { environmentActive } : {}),
    ...(environmentUnverified ? { environmentUnverified: true } : {}),
  };
};

const execute = async (
  args: readonly string[],
  runtime: CliRuntime,
): Promise<
  Readonly<{ value: Record<string, unknown> | { stdout: string } }>
> => {
  const parsed = parseArguments(
    args,
    runtime.stdoutIsTerminal === undefined
      ? {}
      : { stdoutIsTerminal: runtime.stdoutIsTerminal },
  );
  const store = createFileProfileCatalog(
    runtime.profilePath ?? profileCatalogPath(),
  );
  if (parsed.command === "help")
    return { value: { stdout: `${renderPowerHelp()}\n` } };
  if (parsed.command === "setup") {
    const origin = parsed.positionals[0];
    if (!origin) throw new CliInvocationError("setup requires an origin");
    const catalog = await store.read();
    const existing = catalog.profiles.find(
      (profile) => profile.origin === origin,
    );
    const profile =
      existing ??
      (await addServerProfile(store, profileNameFromOrigin(origin), origin, {
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        confirm: (candidate) => confirmProfileTrust(parsed, runtime, candidate),
      }));
    const selected = (await store.read()).selected;
    if (selected !== profile.name) await useServerProfile(store, profile.name);
    return { value: await loginAndEnroll(parsed, runtime, profile) };
  }
  if (parsed.command === "profile" && parsed.subcommand === "add") {
    const [name, origin] = parsed.positionals;
    if (!name || !origin)
      throw new Error("profile add requires a name and origin");
    const profile = await addServerProfile(store, name, origin, {
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      confirm: (candidate) => confirmProfileTrust(parsed, runtime, candidate),
    });
    return {
      value: {
        profile: profile.name,
        origin: profile.origin,
        serverProfileId: profile.pin.serverProfileId,
        message: `Trusted ${profile.origin}`,
      },
    };
  }
  if (parsed.command === "profile" && parsed.subcommand === "use") {
    const name = parsed.positionals[0];
    if (!name) throw new Error("profile use requires a name");
    const profile = await useServerProfile(store, name);
    return {
      value: { profile: profile.name, origin: profile.origin, selected: true },
    };
  }
  if (parsed.command === "profile" && parsed.subcommand === "list") {
    const catalog = await store.read();
    return {
      value: {
        profiles: catalog.profiles.map(({ name, origin, pin }) => ({
          name,
          origin,
          serverProfileId: pin.serverProfileId,
        })),
        ...(catalog.selected ? { selected: catalog.selected } : {}),
      },
    };
  }
  if (parsed.command === "status") {
    const catalog = await store.read();
    const selected = parsed.profile
      ? catalog.profiles.find((profile) => profile.name === parsed.profile)
      : catalog.selected
        ? catalog.profiles.find((profile) => profile.name === catalog.selected)
        : undefined;
    if (parsed.profile && !selected)
      await resolveServerProfile(store, parsed.profile);
    if (!selected)
      return {
        value: {
          profile: null,
          origin: null,
          service: "skipped",
          session: "not-stored",
          device: "not-enrolled",
          nextAction: "run dotrelay setup <origin>",
        },
      };
    return { value: await verifyStatus(runtime, selected) };
  }
  if (parsed.command === "login") {
    const profile = await resolveServerProfile(store, parsed.profile);
    return { value: await loginAndEnroll(parsed, runtime, profile) };
  }
  if (parsed.command === "logout") {
    const profile = await resolveServerProfile(store, parsed.profile);
    const credentials = runtime.credentials ?? createNativeCredentialStore();
    await createSessionStore(credentials).remove(profile.pin);
    return { value: { profile: profile.name, loggedOut: true } };
  }
  if (parsed.command === "context") {
    const profile = await resolveServerProfile(store, parsed.profile);
    const repository = detectGitHubRepository(
      await (runtime.readGitRemotes ?? readGitRemotes)(),
    );
    const resolvedRepository = await resolveGitHubRepository(repository, {
      ...(runtime.githubFetch ? { fetch: runtime.githubFetch } : {}),
    });
    const context = await readWorktreeContext(
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath()),
    );
    if (context && context.serverProfileId !== profile.pin.serverProfileId)
      throw new CliInvocationError(
        "worktree context belongs to a different Server Profile",
      );
    return {
      value: {
        profile: profile.name,
        repository: `${resolvedRepository.host}/${resolvedRepository.owner}/${resolvedRepository.name}`,
        remoteNames: resolvedRepository.remoteNames,
        githubRepositoryId: resolvedRepository.githubRepositoryId,
        ...(context ? { projectId: context.projectId } : {}),
        ...(context?.environmentId
          ? { environmentId: context.environmentId }
          : {}),
        ...(resolveEnvironmentSelection(parsed.environment, context)
          ? {
              environment: resolveEnvironmentSelection(
                parsed.environment,
                context,
              )?.value,
            }
          : {}),
      },
    };
  }
  if (parsed.command === "project" && parsed.subcommand === "link") {
    const profile = await resolveServerProfile(store, parsed.profile);
    const team = parsed.team?.toLowerCase();
    if (!team)
      throw new CliInvocationError("project link requires --team <team-id>");
    const repository = await resolveGitHubRepository(
      detectGitHubRepository(
        await (runtime.readGitRemotes ?? readGitRemotes)(),
      ),
      { ...(runtime.githubFetch ? { fetch: runtime.githubFetch } : {}) },
    );
    const credentials = runtime.credentials ?? createNativeCredentialStore();
    const admin = await createAdminClient(runtime, profile, credentials);
    const project = await linkProject(admin, {
      teamId: team,
      repository: {
        ...repository,
        githubRepositoryId:
          repository.githubRepositoryId ??
          (() => {
            throw new CliError(
              "transient",
              "GitHub repository identity was not resolved",
              {},
              "repository_resolution_failed",
            );
          })(),
      },
    });
    await writeWorktreeContext(
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath()),
      {
        serverProfileId: profile.pin.serverProfileId,
        projectId: project.id,
        ...(project.environment
          ? { environmentId: project.environment.id }
          : {}),
      },
    );
    return {
      value: {
        profile: profile.name,
        projectId: project.id,
        repository: `${repository.host}/${repository.owner}/${repository.name}`,
        ...(project.environment
          ? { environmentId: project.environment.id }
          : {}),
        message: `Linked ${repository.owner}/${repository.name}`,
      },
    };
  }
  if (parsed.command === "env" && parsed.subcommand === "use") {
    const profile = await resolveServerProfile(store, parsed.profile);
    const contextPath =
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath());
    const context = await readWorktreeContext(contextPath);
    if (!context)
      throw new CliInvocationError(
        "No Project selected; use project link before selecting an Environment",
      );
    if (context.serverProfileId !== profile.pin.serverProfileId)
      throw new CliInvocationError(
        "worktree Project belongs to a different Server Profile",
      );
    const environmentId = parsed.environment ?? parsed.positionals[0];
    if (!environmentId) throw new Error("env use requires an Environment id");
    const credentials = runtime.credentials ?? createNativeCredentialStore();
    const admin = await createAdminClient(runtime, profile, credentials);
    const environment = await selectEnvironment(
      admin,
      context.projectId,
      environmentId,
    );
    await writeWorktreeContext(contextPath, {
      ...context,
      environmentId: environment.id,
    });
    return {
      value: {
        profile: profile.name,
        environmentId: environment.id,
        selected: true,
      },
    };
  }
  const deviceTrustCommands = new Set([
    "enroll",
    "begin",
    "approve",
    "complete",
    "backup",
    "recover",
  ]);
  if (
    parsed.command === "device" &&
    deviceTrustCommands.has(parsed.subcommand ?? "")
  ) {
    if (parsed.noInput && !parsed.profile)
      throw new CliInvocationError(
        "--no-input requires explicit --profile for Device trust commands",
      );
    const profile = await resolveServerProfile(store, parsed.profile);
    const credentials = runtime.credentials ?? createNativeCredentialStore();
    const stateDirectory =
      runtime.stateDirectory ??
      dirname(runtime.profilePath ?? profileCatalogPath());
    const workflowOptions = {
      profile,
      credentials,
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      ...(runtime.deviceStorage
        ? { deviceStorage: runtime.deviceStorage }
        : {}),
      ...(runtime.admin ? { admin: runtime.admin } : {}),
      ...(runtime.deviceId ? { deviceId: runtime.deviceId } : {}),
      stateDirectory,
      contextPath: runtime.worktreeConfig ?? "",
      ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
      ...(runtime.confirm ? { confirm: runtime.confirm } : {}),
      ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
      noInput: parsed.noInput,
      force: parsed.force,
      stdoutIsTerminal: runtime.stdoutIsTerminal ?? false,
    };
    if (parsed.subcommand === "enroll")
      return {
        value: await enrollDevice(workflowOptions, parsed.output),
      };
    if (parsed.subcommand === "begin")
      return {
        value: await beginDeviceEnrollment(workflowOptions, parsed.output),
      };
    if (parsed.subcommand === "approve")
      return {
        value: await approveDeviceEnrollment(
          workflowOptions,
          parsed.from ?? "",
        ),
      };
    if (parsed.subcommand === "complete")
      return {
        value: await completeDeviceEnrollment(
          workflowOptions,
          parsed.from ?? "",
        ),
      };
    if (parsed.subcommand === "backup")
      return {
        value: await createRecoveryBackup(workflowOptions, parsed.output ?? ""),
      };
    return {
      value: await restoreRecoveryKit(workflowOptions, parsed.from ?? ""),
    };
  }
  const protectedCommands = new Set([
    "init",
    "push",
    "pull",
    "diff",
    "history",
    "rollback",
  ]);
  if (protectedCommands.has(parsed.command)) {
    if (parsed.noInput && !parsed.profile)
      throw new CliInvocationError("--no-input requires explicit --profile");
    const profile = await resolveServerProfile(store, parsed.profile);
    const contextPath =
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath());
    const localContext = await readWorktreeContext(contextPath);
    const hasProvidedEnvironment =
      parsed.environment !== undefined ||
      (parsed.command === "init" && parsed.positionals.length === 1) ||
      localContext?.environmentId !== undefined;
    if (
      parsed.noInput &&
      parsed.command !== "init" &&
      parsed.command !== "push" &&
      !hasProvidedEnvironment
    )
      throw new CliInvocationError(
        "--no-input requires explicit --environment context",
      );
    const stateDirectory =
      runtime.stateDirectory ??
      dirname(runtime.profilePath ?? profileCatalogPath());
    const deviceId =
      runtime.deviceId ??
      (await readDeviceId(deviceMetadataPath(stateDirectory, profile.pin)));
    let contextToSave:
      | Readonly<{
          readonly serverProfileId: string;
          readonly projectId: string;
          readonly environmentId?: string;
        }>
      | undefined;
    if (!runtime.admin) {
      requireEnrolledDevice(deviceId);
      const repository = await resolveGitHubRepository(
        detectGitHubRepository(
          await (runtime.readGitRemotes ?? readGitRemotes)(),
        ),
        { ...(runtime.githubFetch ? { fetch: runtime.githubFetch } : {}) },
      );
      const credentials = runtime.credentials ?? createNativeCredentialStore();
      const admin =
        runtime.admin ??
        createStrictJsonClient(profile.pin, credentials, {
          ...(deviceId ? { deviceId } : {}),
          ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        });
      // An explicit --team must name a Team the User still belongs to; the
      // service re-checks the Membership when it scopes the lookup. UUIDs are
      // case-insensitive, so the value is normalized before any comparison.
      const explicitTeamId = parsed.team?.toLowerCase();
      let teams: readonly TeamSummary[] | undefined;
      if (explicitTeamId) {
        teams = await listTeams(admin);
        if (!teams.some((team) => team.id === explicitTeamId))
          throw new CliInvocationError("the specified Team is not available");
      }
      const resolution = await findProjectByRepository(
        admin,
        repository.githubRepositoryId ?? "",
        {
          ...(explicitTeamId ? { teamId: explicitTeamId } : {}),
        },
      );
      // The explicit Team, a saved Project that is still an eligible
      // destination, then the sole active Project decide the outcome; any
      // remaining ambiguity is offered as labelled choices.
      let existingProject = resolution.project;
      if (!existingProject && !explicitTeamId) {
        const savedProjectId = localContext?.projectId;
        if (savedProjectId)
          existingProject =
            resolution.candidates.find(
              (candidate) => candidate.id === savedProjectId,
            ) ?? null;
      }
      if (!existingProject && resolution.candidates.length > 1) {
        if (!teams) teams = await listTeams(admin);
        const teamName = (teamId: string): string =>
          teams?.find((team) => team.id === teamId)?.name ?? teamId;
        const label = (candidate: ProjectSummary): string =>
          `${teamName(candidate.teamId)} (${candidate.teamId}) — ${repository.owner}/${repository.name}`;
        if (parsed.noInput)
          throw new CliError(
            "invocation",
            `multiple Projects are linked to this GitHub Repository; pass --team <team-id>:\n${resolution.candidates
              .map((candidate, index) => `${index + 1}. ${label(candidate)}`)
              .join("\n")}`,
            {},
            "project_ambiguous",
          );
        const selectedId = await selectOption(
          "Project",
          resolution.candidates.map((candidate) => ({
            id: candidate.id,
            label: label(candidate),
          })),
          {
            ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
            ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
            // An empty answer must not steer the change to the first
            // candidate in list order.
            defaultToFirst: false,
          },
        );
        const selected = resolution.candidates.find(
          (candidate) => candidate.id === selectedId,
        );
        if (!selected)
          throw new CliInvocationError("choose a Project from the list");
        existingProject = selected;
      }
      if (
        !existingProject &&
        parsed.command !== "init" &&
        parsed.command !== "push"
      )
        throw new CliInvocationError(
          "this GitHub Repository is not linked; run dotrelay init first",
        );
      const ask = async (question: string): Promise<string> => {
        if (runtime.prompt) return runtime.prompt(question);
        const { readTerminalLine } = await import("./terminal");
        return readTerminalLine(question, runtime.terminal);
      };
      const write = (message: string): void => {
        const output = runtime.terminal?.output ?? process.stderr;
        output.write(message);
      };
      const initializedProject =
        existingProject ??
        (await linkProject(admin, {
          teamId: (
            await resolveTeamForProject(admin, {
              ...(explicitTeamId ? { teamId: explicitTeamId } : {}),
              suggestedName: repository.owner,
              noInput: parsed.noInput,
              prompt: ask,
              write,
              ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
            })
          ).id,
          repository: {
            ...repository,
            githubRepositoryId: repository.githubRepositoryId ?? "",
          },
        }));
      // A saved Project that is no longer an eligible destination (archived,
      // relinked, or Membership lost) stops steering the change: its
      // saved Environment is validated against the resolved Project below,
      // where it fails the active check and resolution falls back to the
      // Project's active Environments or an explicit --environment.
      const linkedEnvironmentId =
        existingProject === null
          ? (initializedProject as Awaited<ReturnType<typeof linkProject>>)
              .environment?.id
          : undefined;
      // A saved selection may point at an Environment that was archived (or
      // removed) since it was written; only an active saved Environment can
      // steer the change automatically. Otherwise resolution continues so an
      // eligible active Environment can be chosen or created. The check is
      // skipped entirely when an explicit Environment was supplied.
      const explicitEnvironmentId =
        parsed.environment ??
        (parsed.command === "init" ? parsed.positionals[0] : undefined);
      const savedEnvironmentId = localContext?.environmentId;
      // Usable means "present and still active"; a missing selection is
      // trivially usable because nothing needs to be re-validated.
      let savedSelectionUsable = savedEnvironmentId === undefined;
      if (
        explicitEnvironmentId === undefined &&
        savedEnvironmentId !== undefined
      ) {
        savedSelectionUsable = (
          await listEnvironments(admin, initializedProject.id)
        ).some(
          (environment) =>
            environment.id === savedEnvironmentId &&
            environment.lifecycle === "active",
        );
        // A stale saved selection is not an unambiguous context: init and
        // push may fall back to the Project's active Environments, the other
        // protected commands must not guess.
        if (
          !savedSelectionUsable &&
          parsed.noInput &&
          parsed.command !== "init" &&
          parsed.command !== "push"
        )
          throw new CliInvocationError(
            "--no-input requires explicit --environment context",
          );
      }
      const environmentId =
        explicitEnvironmentId ??
        (savedSelectionUsable ? savedEnvironmentId : undefined) ??
        linkedEnvironmentId ??
        (
          await resolveEnvironmentForProject(admin, initializedProject.id, {
            command: parsed.command,
            noInput: parsed.noInput,
            ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
            ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
          })
        ).id;
      contextToSave = Object.freeze({
        serverProfileId: profile.pin.serverProfileId,
        projectId: initializedProject.id,
        ...(environmentId ? { environmentId } : {}),
      });
    }
    const workflowResult = await runProtectedWorkflow(
      {
        profile,
        credentials: runtime.credentials ?? createNativeCredentialStore(),
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        ...(runtime.deviceStorage
          ? { deviceStorage: runtime.deviceStorage }
          : {}),
        ...(runtime.admin ? { admin: runtime.admin } : {}),
        ...(deviceId ? { deviceId } : {}),
        stateDirectory,
        contextPath,
        ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
        ...(runtime.confirm ? { confirm: runtime.confirm } : {}),
        ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
        noInput: parsed.noInput,
        force: parsed.force,
        stdoutIsTerminal: runtime.stdoutIsTerminal ?? false,
        gitTracking: runtime.gitTrackingProbe ?? createGitTrackingProbe(),
        ...(contextToSave?.environmentId
          ? { environmentId: contextToSave.environmentId }
          : {}),
      },
      parsed,
    );
    // The worktree selection is persisted only after the workflow succeeds,
    // so a failed or declined operation leaves the saved Environment
    // untouched.
    if (contextToSave) await writeWorktreeContext(contextPath, contextToSave);
    return { value: workflowResult };
  }
  throw new CliError(
    "invocation",
    `command ${parsed.command}${parsed.subcommand ? ` ${parsed.subcommand}` : ""} is not available in this foundation build`,
    {},
    "command_unavailable",
  );
};

export const run = async (
  args: readonly string[],
  runtime: CliRuntime = {},
): Promise<CliRunResult> => {
  try {
    rejectForbiddenFlags(args);
    if (args.includes("--help") || args.length === 0)
      return {
        exitCode: EXIT_CODES.success,
        stdout: `${renderHelp()}\n`,
        stderr: "",
      };
    if (args.includes("--version"))
      return {
        exitCode: EXIT_CODES.success,
        stdout: `${version}\n`,
        stderr: "",
      };
    const result = await execute(args, runtime);
    const parsed = parseArguments(
      args,
      runtime.stdoutIsTerminal === undefined
        ? {}
        : { stdoutIsTerminal: runtime.stdoutIsTerminal },
    );
    return {
      exitCode: EXIT_CODES.success,
      stdout:
        "stdout" in result.value
          ? String(result.value.stdout)
          : renderSuccess(parsed, result.value),
      stderr: "",
    };
  } catch (error) {
    const diagnostic = diagnosticForError(error, {
      debug: args.includes("--debug"),
    });
    const parsed = args.includes("--json");
    return {
      exitCode: diagnostic.exitCode,
      stdout: "",
      stderr: parsed
        ? json(diagnostic)
        : `${humanDetailForError(error, {
            debug: args.includes("--debug"),
          })}\n`,
    };
  }
};

if (import.meta.main) {
  const result = await run(
    Bun.argv.slice(2),
    process.stdout.isTTY === undefined
      ? {}
      : { stdoutIsTerminal: process.stdout.isTTY },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (typeof process.stdin.setRawMode === "function")
    process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exit(result.exitCode);
}
