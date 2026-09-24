import { unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
  resolveEnvironmentReference,
  resolveRepositoryIdentity,
  resolveTeamForProject,
  type StrictJsonClient,
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
  type LoginProgress,
  loginWithDeviceAuthorization,
  openVerificationPage,
} from "./auth";
import {
  bold,
  epilogue,
  errorCard,
  glyph,
  heading,
  type KvRow,
  kv,
  note,
  paint,
  reviewFrame,
  statusCard,
  stepDone,
  type Tone,
} from "./components";
import {
  type GitHubRepositorySelection,
  type GitRemote,
  readStoredWorktreeContext,
  readWorktreeContext,
  repositoryChoiceFields,
  repositoryChoiceFrom,
  resolveEnvironmentSelection,
  sameGitHubIdentity,
  selectGitHubRepository,
  type WorktreeContext,
  worktreeConfigPath,
  writeWorktreeContext,
} from "./context";
import { type CredentialStore, createFileCredentialStore } from "./credentials";
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
  presentationForError,
  sanitizeCliText,
} from "./errors";
import { createGitTrackingProbe, type GitTrackingProbe } from "./git-tracking";
import {
  helpLabelFor,
  helpTopicFor,
  renderCommandHelp,
  renderHelp,
  renderPowerHelp,
} from "./help";
import {
  defaultNetworkPolicy,
  type NetworkPolicy,
  probeNetworkPolicy,
  type RetryReason,
} from "./network";
import {
  addServerProfile,
  type CliServerProfile,
  createFileProfileCatalog,
  type FetchFunction,
  profileCatalogPath,
  profileNameFromOrigin,
  resolveServerProfile,
  useServerProfile,
  withDefaultProtocol,
} from "./profile";
import type { TerminalIo } from "./terminal";
import {
  confirmAction,
  rewriteRegion,
  selectOption,
  supportsRawMode,
} from "./ui";
import { defaultOrigin, version } from "./version";
import {
  approveDeviceEnrollment,
  beginDeviceEnrollment,
  completeDeviceEnrollment,
  createRecoveryCodeBackup,
  enrollDevice,
  enrollFirstDevice,
  recoverAccountKey,
  revokeAccountKeyWrapper,
  runProtectedWorkflow,
  setupDeviceAccountKey,
  transferAccountKey,
  workspaceBoundaryFields,
} from "./workflow";
import { consumeDisplayedRecoveryCodePath } from "./workflow-account-key";
import { rotateProjectEpoch } from "./workflow-epoch-rotation";

export { renderHelp, renderPowerHelp } from "./help";

export { version } from "./version";
export type { TerminalIo };

export const main = (args: string[]): string => {
  rejectForbiddenFlags(args);
  if (args.includes("--version")) return version;
  return renderHelp();
};

export type CliRuntime = Readonly<{
  readonly profilePath?: string;
  readonly credentials?: CredentialStore;
  readonly fetch?: FetchFunction;
  readonly networkPolicy?: NetworkPolicy;
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

// The default credential store is the local file store rooted in the Server
// Profile catalog's state directory, so DOTRELAY_CONFIG_DIR moves it with the
// rest of the CLI's state. Embeds may supply their own store through
// CliRuntime.credentials.
const localCredentials = (runtime: CliRuntime): CredentialStore =>
  runtime.credentials ??
  createFileCredentialStore(
    join(dirname(runtime.profilePath ?? profileCatalogPath()), "credentials"),
  );

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

// The same explicit-choice inputs steer every command that resolves a
// GitHub Repository: the choice recorded in the worktree context, the
// documented noninteractive --remote override, and the interaction
// primitives.
const repositorySelectionOptions = (
  parsed: ParsedArguments,
  runtime: CliRuntime,
  context: WorktreeContext | null,
) => ({
  saved: repositoryChoiceFrom(context),
  noInput: parsed.noInput,
  ...(parsed.remote !== undefined ? { remoteName: parsed.remote } : {}),
  ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
  ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
});

// Resolves the selected GitHub Repository to its stable Repository Identity.
// While the remote still points at the repository recorded in the worktree
// context, the recorded identity is trusted as-is and no further resolution
// runs, so an established linkage never needs to reach GitHub again.
// Otherwise the Server Profile resolves the descriptive name on the
// signed-in User's behalf with their Delegated GitHub Access.
const resolveSelectedRepository = async (
  admin: Pick<StrictJsonClient, "get">,
  context: WorktreeContext | null,
  selection: GitHubRepositorySelection,
): Promise<
  Readonly<{
    readonly identity: string;
    readonly owner: string;
    readonly name: string;
  }>
> => {
  const record = repositoryChoiceFrom(context);
  const recordedIdentity = context?.repositoryIdentity;
  if (
    record !== null &&
    recordedIdentity !== undefined &&
    sameGitHubIdentity(record, selection.choice)
  )
    return {
      identity: recordedIdentity,
      owner: record.owner,
      name: record.name,
    };
  const resolved = await resolveRepositoryIdentity(admin, {
    host: "github.com",
    owner: selection.choice.owner,
    name: selection.choice.name,
  });
  // An explicit --remote override declares which Repository identifies this
  // worktree, and the record is replaced when the command succeeds, so it is
  // never blocked by the rename diagnosis.
  if (
    record !== null &&
    recordedIdentity !== undefined &&
    selection.source !== "override" &&
    recordedIdentity !== resolved.identity
  )
    throw new CliError(
      "conflict",
      `the remote ${selection.choice.remote} names ${selection.choice.owner}/${selection.choice.name}, a different GitHub Repository than the one recorded for this worktree (${record.owner}/${record.name}); re-point the remote at the recorded repository, or re-record the choice with dotrelay context --remote ${selection.choice.remote}`,
      {},
      "repository_renamed",
    );
  // A matching identity means the recorded Repository was renamed or
  // transferred: follow its current descriptive name.
  return {
    identity: resolved.identity,
    owner: resolved.owner,
    name: resolved.name,
  };
};

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

const abbreviateId = (id: string): string => {
  const match =
    /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})$/i.exec(
      id,
    );
  return match ? `${match[1]}-${match[2]?.slice(0, 4)}` : id.slice(0, 12);
};

type StatusLine = Readonly<{ readonly text: string; readonly tone: Tone }>;

// Stored-local state is labelled as such; only the service-verified lines
// may claim a session or Device as current.
const statusSessionLine = (session: string): StatusLine => {
  if (session === "verified")
    return { text: "signed in · verified", tone: "brand" };
  if (session === "expired")
    return { text: "expired or revoked", tone: "danger" };
  if (session === "unverified")
    return { text: "signed in · not verified", tone: "warn" };
  return { text: "not signed in", tone: "muted" };
};

const statusDeviceLine = (device: string, name?: string): StatusLine => {
  const label =
    device === "active"
      ? name
        ? `active · ${name}`
        : "active · verified"
      : device === "not-active"
        ? "not active"
        : device === "unusable"
          ? "keys unusable"
          : device === "unverified"
            ? "last known · not verified"
            : "not enrolled";
  const tone =
    device === "active"
      ? "brand"
      : device === "not-active" || device === "unusable"
        ? "danger"
        : device === "unverified"
          ? "warn"
          : "muted";
  return { text: label, tone };
};

// The note names the stage that could not complete; once the service has
// answered one probe it must never be reported as unreachable.
const statusServiceNote = (service: string, session: string): string | null => {
  if (service === "offline")
    return session === "verified"
      ? "The Server Profile could not be reached"
      : "The Server Profile could not be reached";
  if (service === "unavailable")
    return session === "verified"
      ? "The Server Profile could not complete the Device check"
      : "The Server Profile could not be verified";
  return null;
};

const statusNextAction = (value: Record<string, unknown>): string | null => {
  const next = typeof value.nextAction === "string" ? value.nextAction : "none";
  if (next === "none") return null;
  if (next === "run dotrelay login") return "dotrelay login";
  if (next === "run dotrelay device enroll") return "dotrelay device enroll";
  if (next === "run dotrelay device recover") return "dotrelay device recover";
  if (next.startsWith("run dotrelay env use"))
    return "dotrelay env use <environment-id-or-label>";
  if (next.startsWith("run dotrelay setup")) return "dotrelay setup <origin>";
  if (next === "retry when the Server Profile is reachable")
    return "retry dotrelay status";
  if (next === "retry dotrelay status") return "retry dotrelay status";
  if (next.startsWith("this build targets")) return "dotrelay login";
  return next;
};

const renderStatusCard = (value: Record<string, unknown>): string => {
  const profile = typeof value.profile === "string" ? value.profile : "";
  const origin = typeof value.origin === "string" ? value.origin : "";
  const session =
    typeof value.session === "string" ? value.session : "not-stored";
  const device =
    typeof value.device === "string" ? value.device : "not-enrolled";
  const deviceName =
    typeof value.deviceName === "string" && value.deviceName
      ? value.deviceName
      : undefined;
  const service = typeof value.service === "string" ? value.service : "skipped";
  const sessionLine = statusSessionLine(session);
  const deviceLine = statusDeviceLine(device, deviceName);
  const rows: KvRow[] = [
    { key: "Server Profile", value: profile || undefined },
    { key: "Origin", value: origin || undefined, tone: "muted" },
    { key: "Session", value: sessionLine.text, tone: sessionLine.tone },
    { key: "Device", value: deviceLine.text, tone: deviceLine.tone },
  ];
  if (typeof value.projectId === "string")
    rows.push({
      key: "Project",
      value: `${abbreviateId(sanitizeCliText(String(value.projectId)))}`,
      tone: "fg",
    });
  const environment =
    typeof value.environment === "string"
      ? value.environment
      : typeof value.environmentId === "string"
        ? value.environmentId
        : "";
  if (environment) {
    const flagged =
      value.environmentActive === false || value.environmentUnverified === true;
    const marker =
      value.environmentActive === false
        ? " · not active"
        : value.environmentUnverified === true
          ? " · not verified"
          : "";
    rows.push({
      key: "Environment",
      value: `${environment}${marker}`,
      tone: flagged ? "warn" : "fg",
    });
  }
  const serviceNote = statusServiceNote(service, session);
  const next = statusNextAction(value);
  const footers: string[] = [];
  if (serviceNote) footers.push(`  ${glyph("warn")}  ${serviceNote}`);
  if (value.environmentUnverified === true)
    footers.push(
      `  ${glyph("warn")}  The stored Environment could not be verified`,
    );
  if (next !== null) footers.push(`  ${glyph("info")}  Next: ${next}`);
  if (footers.length === 0)
    footers.push(`  ${glyph("ok")}  ${paint("Fully connected", "brand")}`);
  return `${statusCard(rows)}
${footers.join("\n")}
`;
};

const renderProfileList = (value: Record<string, unknown>): string => {
  const profiles = Array.isArray(value.profiles) ? value.profiles : [];
  if (profiles.length === 0)
    return `${note("No Server Profiles saved. Run dotrelay setup <origin> to add one.")}\n`;
  const rows = profiles.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : "",
      origin: typeof record.origin === "string" ? record.origin : "",
      selected: value.selected === record.name,
    };
  });
  const lines = rows.map((row) => {
    const marker = row.selected ? paint("▸", "brand") : paint("·", "ghost");
    const name = row.selected ? bold(row.name) : paint(row.name, "muted");
    return `  ${marker}  ${name}  ${paint(row.origin, "faint")}`;
  });
  return `${lines.join("\n")}\n`;
};

const renderContextCard = (value: Record<string, unknown>): string => {
  const rows: KvRow[] = [
    {
      key: "Repository",
      value:
        typeof value.repository === "string"
          ? String(value.repository)
          : undefined,
    },
  ];
  if (Array.isArray(value.remoteNames)) {
    rows.push({
      key: "Remotes",
      value: (value.remoteNames as readonly string[]).join(", "),
      tone: "muted",
    });
  }
  if (typeof value.githubRepositoryId === "string")
    rows.push({
      key: "GitHub id",
      value: `verified (${abbreviateId(value.githubRepositoryId)})`,
      tone: "brand",
    });
  if (typeof value.projectId === "string")
    rows.push({
      key: "Project",
      value: abbreviateId(value.projectId),
      tone: "fg",
    });
  if (typeof value.environment === "string")
    rows.push({ key: "Environment", value: value.environment, tone: "fg" });
  else if (typeof value.environmentId === "string")
    rows.push({
      key: "Environment",
      value: abbreviateId(value.environmentId),
      tone: "muted",
    });
  const next =
    typeof value.nextAction === "string" ? String(value.nextAction) : "";
  const footers: string[] = [];
  if (next.length > 0) footers.push(`  ${glyph("info")}  ${next}`);
  else footers.push(`  ${glyph("ok")}  ${paint("Context recorded", "brand")}`);
  return `${kv(rows)}\n\n${footers.join("\n")}\n`;
};

const renderDeviceResult = (
  command: string,
  value: Record<string, unknown>,
): string => {
  const rows: KvRow[] = [];
  if (typeof value.deviceId === "string")
    rows.push({ key: "Device", value: abbreviateId(value.deviceId) });
  if (typeof value.deviceName === "string" && value.deviceName)
    rows.push({ key: "Name", value: sanitizeCliText(value.deviceName) });
  if (typeof value.enrollmentId === "string")
    rows.push({
      key: "Enrollment",
      value: abbreviateId(value.enrollmentId),
      tone: "accent",
    });
  if (typeof value.request === "string")
    rows.push({ key: "Handoff", value: value.request, tone: "muted" });
  if (typeof value.active === "boolean" && command !== "backup")
    rows.push({
      key: "State",
      value: value.active ? "active · verified" : "pending approval",
      tone: value.active ? "brand" : "warn",
    });
  if (typeof value.recoveryCode === "string")
    rows.push({
      key: "Recovery code",
      value: value.recoveryCode,
      tone: "accent",
    });
  if (typeof value.wrapperId === "string")
    rows.push({
      key: "Wrapper",
      value: abbreviateId(value.wrapperId),
      tone: "muted",
    });
  if (typeof value.via === "string")
    rows.push({
      key: "Via",
      value:
        value.via === "recovery-code" ? "recovery code" : "device transfer",
      tone: "accent",
    });
  if (typeof value.transferId === "string")
    rows.push({
      key: "Transfer",
      value: abbreviateId(value.transferId),
      tone: "accent",
    });
  if (typeof value.recipientDeviceId === "string")
    rows.push({
      key: "To",
      value: abbreviateId(value.recipientDeviceId),
      tone: "muted",
    });
  if (typeof value.expiresAt === "string")
    rows.push({ key: "Expires", value: value.expiresAt, tone: "muted" });
  const message =
    typeof value.message === "string" ? sanitizeCliText(value.message) : "";
  const epilogues: string[] = [];
  if (rows.length > 0) epilogues.push(kv(rows));
  if (message.length > 0) epilogues.push(`  ${message}`);
  if (epilogues.length === 0)
    epilogues.push(`  ${glyph("ok")}  ${paint("Complete", "brand")}`);
  return `${heading(`device ${command}`)}\n\n${epilogues.join("\n")}\n`;
};

const renderGenericResult = (value: Record<string, unknown>): string => {
  const rows: KvRow[] = Object.entries(value)
    .filter(([, entry]) => typeof entry !== "object")
    .map(([key, entry]) => ({
      key,
      value:
        typeof entry === "string"
          ? entry
          : entry === null
            ? undefined
            : String(entry),
      tone: "fg",
    }));
  if (rows.length === 0) return `${"  "}${"Complete"}\n`;
  return `${kv(rows)}\n`;
};

const renderSuccess = (
  parsed: ParsedArguments,
  value: Record<string, unknown>,
): string => {
  if (parsed.json) return json({ ok: true, ...value });
  if ("stdout" in value && typeof value.stdout === "string")
    return value.stdout;
  if (parsed.command === "status") return renderStatusCard(value);
  if (parsed.command === "profile" && parsed.subcommand === "list")
    return renderProfileList(value);
  if (parsed.command === "context") return renderContextCard(value);
  if (parsed.command === "device" && parsed.subcommand)
    return renderDeviceResult(parsed.subcommand, value);
  if (typeof value.message === "string") {
    const message = sanitizeCliText(value.message);
    if (parsed.command === "logout")
      return `${epilogue(`Signed out of ${String(value.profile ?? "the Server Profile")}.`)}\n`;
    if (parsed.command === "profile" && parsed.subcommand === "use")
      return `${epilogue(`Selected ${String(value.profile)}.`)}\n`;
    if (parsed.command === "env" && parsed.subcommand === "use")
      return `${epilogue(
        `Environment set to ${String(value.environmentId ?? value.environment ?? "the selection")}.`,
      )}\n`;
    if (parsed.command === "project" && parsed.subcommand === "link")
      return `${epilogue(`Linked ${String(value.repository ?? "the Repository")} to this worktree.`)}\n`;
    return `${message}\n`;
  }
  return `${renderGenericResult(value)}\n`;
};

// The runtime's transport options flow into profile resolution so a
// build-stamped default origin is established over the same fetch and
// network policy the rest of the command uses.
const profileOptions = (runtime: CliRuntime) => ({
  ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
  ...(runtime.networkPolicy ? { networkPolicy: runtime.networkPolicy } : {}),
});

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
  const frame = reviewFrame({
    title: "Trust this Server Profile",
    body: [
      kv([
        { key: "Origin", value: candidate.origin },
        {
          key: "Id",
          value: abbreviateId(candidate.pin.serverProfileId),
          tone: "faint",
        },
      ]),
    ].join("\n"),
    question: "Trust this Server Profile? [Y/n]",
  });
  output.write(`${frame}\n`);
  if (runtime.confirm)
    return await runtime.confirm(`Trust ${candidate.origin}? [Y/n]`);
  if (
    !runtime.prompt &&
    supportsRawMode(runtime.terminal?.input ?? process.stdin)
  )
    return await confirmAction(`Trust ${candidate.origin}?`, {
      ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
      silent: true,
      default: "yes",
    });
  const { readTerminalLine } = await import("./terminal");
  const answer = runtime.prompt
    ? await runtime.prompt(`Trust ${candidate.origin}? [Y/n]`)
    : await readTerminalLine(
        `Trust ${candidate.origin}? [Y/n]`,
        runtime.terminal,
        false,
      );
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "" || trimmed === "y" || trimmed === "yes";
};

const deviceWorkflowOptions = (
  parsed: ParsedArguments,
  runtime: CliRuntime,
  profile: Awaited<ReturnType<typeof resolveServerProfile>>,
  credentials: CredentialStore,
) => {
  const stateDirectory =
    runtime.stateDirectory ??
    dirname(runtime.profilePath ?? profileCatalogPath());
  return {
    profile,
    credentials,
    ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
    ...(runtime.networkPolicy ? { networkPolicy: runtime.networkPolicy } : {}),
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
  credentials: CredentialStore,
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
    ...(runtime.networkPolicy ? { networkPolicy: runtime.networkPolicy } : {}),
  });
};

const describeExpiry = (seconds: number): string => {
  if (seconds % 60 === 0) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
};

const describeDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}m ${rest}s`;
};

const retryReasonPhrase: Record<RetryReason, string> = {
  offline: "The Server Profile is unreachable",
  stalled: "The Server Profile stopped responding",
  // A rate limit or a 5xx answer: both are transient server conditions.
  server: "The Server Profile is temporarily unavailable",
};

const loginAndEnroll = async (
  parsed: ParsedArguments,
  runtime: CliRuntime,
  profile: Awaited<ReturnType<typeof resolveServerProfile>>,
): Promise<Record<string, unknown>> => {
  const credentials = localCredentials(runtime);
  const output = runtime.terminal?.output ?? process.stderr;
  const policy = runtime.networkPolicy ?? defaultNetworkPolicy;
  const outputIsTty =
    (output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;
  const opensBrowser = !(parsed.noOpen || parsed.noInput);
  let manualPath = !opensBrowser;
  let openFailed = false;
  let waitingBody: readonly string[] = [];
  let waitLines = 0;
  let retryState: LoginProgress | null = null;
  let waitStartedAtMs: number | null = null;
  let expiresAtMs: number | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  const elapsedSeconds = (): number =>
    waitStartedAtMs === null
      ? 0
      : Math.max(0, Math.round((policy.now() - waitStartedAtMs) / 1000));
  const retryLine = (
    progress: Extract<LoginProgress, { readonly kind: "retry" }>,
  ): string =>
    `${retryReasonPhrase[progress.reason]}; ${progress.maxAttempts !== undefined ? `retry ${progress.attempt} of ${progress.maxAttempts}` : `retry ${progress.attempt}`} — next in ${Math.max(1, Math.ceil(progress.nextDelayMs / 1000))}s`;
  const renderLoginCard = (hint: string): string => {
    const [url, code, expiry] = waitingBody;
    const lines = [
      `  ${bold(`Sign in to ${profile.name}`)}`,
      "",
      `    ${paint("▸", "brand")}  ${paint(url ?? "", "info")}`,
    ];
    if (code) lines.push(`     ${paint("Code", "faint")}   ${bold(code)}`);
    if (expiry)
      lines.push(
        `     ${paint("Expires", "faint")}  ${paint(`in ${expiry}`, "muted")}`,
      );
    if (openFailed)
      lines.push(
        "",
        `     ${paint("Could not open a browser automatically; open the URL above in any browser.", "warn")}`,
      );
    lines.push("", `     ${paint(hint, "muted")}`, "");
    return lines.join("\n");
  };
  const renderWaiting = (): void => {
    const elapsed = elapsedSeconds();
    const hint =
      retryState !== null && retryState.kind === "retry"
        ? retryLine(retryState)
        : manualPath
          ? "Open the URL above to complete sign-in"
          : `Waiting for the browser${elapsed >= 1 ? ` — ${describeDuration(elapsed)}` : ""}`;
    waitLines = rewriteRegion(output, waitLines, renderLoginCard(hint));
  };
  const stopTicker = (): void => {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
  const startTicker = (): void => {
    if (parsed.json || !outputIsTty) return;
    stopTicker();
    // Redraw the waiting state once per second so the elapsed time stays
    // honest while the operator approves the sign-in.
    tickTimer = setInterval(() => renderWaiting(), 1000);
  };
  const reportProgress = (progress: LoginProgress): void => {
    if (progress.kind === "retry") retryState = progress;
    if (parsed.json) {
      output.write(
        json(
          progress.kind === "retry"
            ? {
                ok: true,
                event: "device_login_retry",
                attempt: progress.attempt,
                ...(progress.maxAttempts !== undefined
                  ? { maxAttempts: progress.maxAttempts }
                  : {}),
                reason: progress.reason,
                nextDelaySeconds: Math.max(
                  0,
                  Math.ceil(progress.nextDelayMs / 1000),
                ),
                elapsedSeconds: elapsedSeconds(),
                ...(expiresAtMs !== null
                  ? {
                      expiresInSeconds: Math.max(
                        0,
                        Math.ceil((expiresAtMs - policy.now()) / 1000),
                      ),
                    }
                  : {}),
              }
            : {
                ok: true,
                event: "device_login_resumed",
                elapsedSeconds: elapsedSeconds(),
                ...(expiresAtMs !== null
                  ? {
                      expiresInSeconds: Math.max(
                        0,
                        Math.ceil((expiresAtMs - policy.now()) / 1000),
                      ),
                    }
                  : {}),
              },
        ),
      );
      return;
    }
    if (!outputIsTty) {
      // Piped human output cannot redraw the waiting card, so each change
      // is a single appended line.
      if (progress.kind === "retry") output.write(`${retryLine(progress)}\n`);
      else output.write("The Server Profile is back; still waiting\n");
      return;
    }
    renderWaiting();
  };
  let login: Awaited<ReturnType<typeof loginWithDeviceAuthorization>>;
  try {
    login = await loginWithDeviceAuthorization(
      profile.pin,
      createSessionStore(credentials),
      {
        noOpen: parsed.noOpen || parsed.noInput,
        networkPolicy: policy,
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        open: runtime.open ?? openVerificationPage,
        onAuthorization: (authorization, verificationUrl) => {
          waitStartedAtMs = policy.now();
          expiresAtMs = waitStartedAtMs + authorization.expiresInSeconds * 1000;
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
            authorization.userCode,
            describeExpiry(authorization.expiresInSeconds),
          ];
          renderWaiting();
          startTicker();
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
        onProgress: reportProgress,
      },
    );
  } finally {
    stopTicker();
    // A failed login must not leave the waiting card on screen behind the
    // error diagnostic, so the region is cleared on every exit.
    if (!parsed.json && waitLines > 0)
      waitLines = rewriteRegion(output, waitLines, "");
  }
  if (!parsed.json) stepDone(`Signed in to ${profile.name}`);
  const enrollment = await enrollFirstDevice(
    deviceWorkflowOptions(parsed, runtime, profile, credentials),
  );
  if (!parsed.json)
    stepDone(
      enrollment.existing ? "Device already enrolled" : "Device enrolled",
    );
  return {
    profile: profile.name,
    userCode: login.userCode,
    verificationUri: login.verificationUri,
    deviceId: enrollment.deviceId,
    device: enrollment.active ? "enrolled" : "not enrolled",
    ...(enrollment.deviceName ? { deviceName: enrollment.deviceName } : {}),
    message: enrollment.existing
      ? `Signed in to ${profile.name}. Device already enrolled.`
      : `Signed in to ${profile.name}. Device enrolled.`,
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
  const credentials = localCredentials(runtime);
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
  let deviceName: string | undefined;
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
        ...(runtime.networkPolicy
          ? { networkPolicy: runtime.networkPolicy }
          : { networkPolicy: probeNetworkPolicy }),
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
          if (keysMatch) {
            const name = deviceRecord?.name;
            if (typeof name === "string" && name) deviceName = name;
          }
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
            ? "run dotrelay env use <environment-id-or-label>"
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
    ...(deviceName ? { deviceName } : {}),
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

const HUMAN_HEADING_COMMANDS = new Set([
  "setup",
  "login",
  "logout",
  "init",
  "push",
  "pull",
  "rollback",
  "context",
  "profile",
  "device",
  "project",
  "env",
]);

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
  if (!parsed.json && HUMAN_HEADING_COMMANDS.has(parsed.command)) {
    const output = runtime.terminal?.output ?? process.stderr;
    output.write(
      `${heading(
        parsed.subcommand
          ? `${parsed.command} ${parsed.subcommand}`
          : parsed.command,
      )}\n\n`,
    );
  }
  const store = createFileProfileCatalog(
    runtime.profilePath ?? profileCatalogPath(),
  );
  if (parsed.command === "help") {
    if (parsed.positionals.length === 0)
      return { value: { stdout: `${renderPowerHelp()}\n` } };
    const topic = parsed.positionals;
    const label = helpLabelFor(topic);
    if (!label)
      throw new CliInvocationError(
        `${topic.join(" ")} is not a command; usage: dotrelay help [<command>]`,
      );
    return { value: { stdout: `${renderCommandHelp(label)}\n` } };
  }
  if (parsed.command === "setup") {
    const rawOrigin = parsed.positionals[0];
    if (!rawOrigin) throw new CliInvocationError("setup requires an origin");
    const origin = withDefaultProtocol(rawOrigin);
    const catalog = await store.read();
    const existing = catalog.profiles.find(
      (profile) => profile.origin === origin,
    );
    const profile =
      existing ??
      (await addServerProfile(store, profileNameFromOrigin(origin), origin, {
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        ...(runtime.networkPolicy
          ? { networkPolicy: runtime.networkPolicy }
          : { networkPolicy: probeNetworkPolicy }),
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
      ...(runtime.networkPolicy
        ? { networkPolicy: runtime.networkPolicy }
        : { networkPolicy: probeNetworkPolicy }),
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
          // A build that ships a default origin names the service its
          // commands will use; builds without one still require setup.
          origin: defaultOrigin ?? null,
          service: "skipped",
          session: "not-stored",
          device: "not-enrolled",
          nextAction: defaultOrigin
            ? `this build targets ${defaultOrigin}; run dotrelay login`
            : "run dotrelay setup <origin>",
        },
      };
    return { value: await verifyStatus(runtime, selected) };
  }
  if (parsed.command === "login") {
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    return { value: await loginAndEnroll(parsed, runtime, profile) };
  }
  if (parsed.command === "logout") {
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    const credentials = localCredentials(runtime);
    await createSessionStore(credentials).remove(profile.pin);
    return { value: { profile: profile.name, loggedOut: true } };
  }
  if (parsed.command === "context") {
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    const contextPath =
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath());
    const context = await readWorktreeContext(contextPath);
    // A context holding only the repository choice belongs to no Server
    // Profile; ownership is only a constraint once a profile is recorded.
    if (
      context?.serverProfileId !== undefined &&
      context.serverProfileId !== profile.pin.serverProfileId
    )
      throw new CliInvocationError(
        "worktree context belongs to a different Server Profile",
      );
    const selection = await selectGitHubRepository(
      await (runtime.readGitRemotes ?? readGitRemotes)(),
      repositorySelectionOptions(parsed, runtime, context),
    );
    // Verifying the Repository Identity is the Server Profile's work for the
    // User: it needs a session and an active Device, and while those are
    // unavailable the command reports the descriptive selection and the
    // recorded identity instead of reaching GitHub itself.
    let verifiedIdentity: string | undefined;
    const recordedChoice = repositoryChoiceFrom(context);
    if (
      recordedChoice !== null &&
      context?.repositoryIdentity !== undefined &&
      sameGitHubIdentity(recordedChoice, selection.choice)
    )
      verifiedIdentity = context.repositoryIdentity;
    else if (runtime.admin) {
      verifiedIdentity = (
        await resolveRepositoryIdentity(runtime.admin, {
          host: "github.com",
          owner: selection.choice.owner,
          name: selection.choice.name,
        })
      ).identity;
    } else {
      const credentials = localCredentials(runtime);
      const sessionToken = await createSessionStore(credentials).get(
        profile.pin,
      );
      const stateDirectory =
        runtime.stateDirectory ??
        dirname(runtime.profilePath ?? profileCatalogPath());
      const deviceId =
        runtime.deviceId ??
        (sessionToken
          ? await readDeviceId(deviceMetadataPath(stateDirectory, profile.pin))
          : null);
      if (sessionToken && deviceId) {
        const admin = await createAdminClient(runtime, profile, credentials);
        verifiedIdentity = (
          await resolveRepositoryIdentity(admin, {
            host: "github.com",
            owner: selection.choice.owner,
            name: selection.choice.name,
          })
        ).identity;
      }
    }
    // The choice is recorded only after the whole command succeeds; a
    // verified identity is recorded with it so later runs match the local
    // record without resolving again.
    if (selection.source !== "detected" || verifiedIdentity !== undefined)
      await writeWorktreeContext(contextPath, {
        ...(context ?? {}),
        ...repositoryChoiceFields(selection.choice),
        ...(verifiedIdentity !== undefined
          ? { repositoryIdentity: verifiedIdentity }
          : {}),
      });
    return {
      value: {
        profile: profile.name,
        repository: `github.com/${selection.repository.owner}/${selection.repository.name}`,
        remoteNames: selection.repository.remoteNames,
        ...(verifiedIdentity !== undefined
          ? { githubRepositoryId: verifiedIdentity }
          : {}),
        ...(verifiedIdentity === undefined
          ? {
              nextAction:
                "sign in to this Server Profile and enroll a Device to verify the repository identity",
            }
          : {}),
        ...(context?.projectId ? { projectId: context.projectId } : {}),
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
  if (parsed.command === "project" && parsed.subcommand === "rotate") {
    if (parsed.noInput && !parsed.profile)
      throw new CliInvocationError(
        "--no-input requires explicit --profile for project rotate",
      );
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    const credentials = localCredentials(runtime);
    const stateDirectory =
      runtime.stateDirectory ??
      dirname(runtime.profilePath ?? profileCatalogPath());
    return {
      value: await rotateProjectEpoch(
        {
          profile,
          credentials,
          ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
          ...(runtime.networkPolicy
            ? { networkPolicy: runtime.networkPolicy }
            : {}),
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
        },
        parsed,
      ),
    };
  }
  if (parsed.command === "project" && parsed.subcommand === "link") {
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    // parseArguments already rejects project link without --team; this only
    // narrows the parsed type, keeping the parser the single source of truth.
    const team =
      parsed.team?.toLowerCase() ??
      (() => {
        throw new CliInvocationError(
          "project link requires --team <team-id>; usage: dotrelay project link --team <team-id>",
        );
      })();
    const contextPath =
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath());
    const context = await readStoredWorktreeContext(contextPath);
    const selection = await selectGitHubRepository(
      await (runtime.readGitRemotes ?? readGitRemotes)(),
      repositorySelectionOptions(parsed, runtime, context),
    );
    const credentials = localCredentials(runtime);
    const admin = await createAdminClient(runtime, profile, credentials);
    const resolved = await resolveSelectedRepository(admin, context, selection);
    const project = await linkProject(admin, {
      teamId: team,
      repository: {
        host: "github.com",
        owner: resolved.owner,
        name: resolved.name,
        githubRepositoryId: resolved.identity,
      },
    });
    await writeWorktreeContext(contextPath, {
      serverProfileId: profile.pin.serverProfileId,
      projectId: project.id,
      ...(project.environment ? { environmentId: project.environment.id } : {}),
      repositoryRemote: selection.choice.remote,
      repositoryOwner: resolved.owner,
      repositoryName: resolved.name,
      repositoryIdentity: resolved.identity,
    });
    return {
      value: {
        profile: profile.name,
        projectId: project.id,
        repository: `github.com/${resolved.owner}/${resolved.name}`,
        ...(project.environment
          ? { environmentId: project.environment.id }
          : {}),
        message: `Linked ${resolved.owner}/${resolved.name}`,
      },
    };
  }
  if (parsed.command === "env" && parsed.subcommand === "use") {
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    const contextPath =
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath());
    const context = await readWorktreeContext(contextPath);
    if (!context || context.projectId === undefined)
      throw new CliInvocationError(
        "No Project selected; use project link before selecting an Environment",
      );
    if (context.serverProfileId !== profile.pin.serverProfileId)
      throw new CliInvocationError(
        "worktree Project belongs to a different Server Profile",
      );
    const environmentReference = parsed.environment ?? parsed.positionals[0];
    if (!environmentReference)
      throw new Error("env use requires an Environment id or label");
    const credentials = localCredentials(runtime);
    const admin = await createAdminClient(runtime, profile, credentials);
    const environment = await resolveEnvironmentReference(
      admin,
      context.projectId,
      environmentReference,
      {
        noInput: parsed.noInput,
        ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
        ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
      },
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
    "setup",
    "transfer",
    "revoke-wrapper",
  ]);
  if (
    parsed.command === "device" &&
    deviceTrustCommands.has(parsed.subcommand ?? "")
  ) {
    if (parsed.noInput && !parsed.profile)
      throw new CliInvocationError(
        "--no-input requires explicit --profile for Device trust commands",
      );
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    const credentials = localCredentials(runtime);
    const stateDirectory =
      runtime.stateDirectory ??
      dirname(runtime.profilePath ?? profileCatalogPath());
    const workflowOptions = {
      profile,
      credentials,
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      ...(runtime.networkPolicy
        ? { networkPolicy: runtime.networkPolicy }
        : {}),
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
      return { value: await createRecoveryCodeBackup(workflowOptions) };
    if (parsed.subcommand === "recover")
      return {
        value: await recoverAccountKey(workflowOptions, {
          ...(parsed.recoveryCodeFile !== undefined
            ? { recoveryCodeFile: parsed.recoveryCodeFile }
            : {}),
          ...(parsed.transfer !== undefined
            ? { transferId: parsed.transfer }
            : {}),
        }),
      };
    if (parsed.subcommand === "setup")
      return { value: await setupDeviceAccountKey(workflowOptions) };
    if (parsed.subcommand === "transfer")
      return {
        value: await transferAccountKey(workflowOptions, parsed.to ?? ""),
      };
    if (parsed.subcommand === "revoke-wrapper")
      return {
        value: await revokeAccountKeyWrapper(
          workflowOptions,
          parsed.wrapperId ?? "",
        ),
      };
    throw new CliInvocationError(
      "unrecognized device command; run dotrelay device --help",
    );
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
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
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
          readonly repositoryRemote: string;
          readonly repositoryOwner: string;
          readonly repositoryName: string;
          readonly repositoryIdentity: string;
        }>
      | undefined;
    if (!runtime.admin) {
      requireEnrolledDevice(deviceId);
      const selection: GitHubRepositorySelection = await selectGitHubRepository(
        await (runtime.readGitRemotes ?? readGitRemotes)(),
        repositorySelectionOptions(parsed, runtime, localContext),
      );
      const credentials = localCredentials(runtime);
      const admin =
        runtime.admin ??
        createStrictJsonClient(profile.pin, credentials, {
          ...(deviceId ? { deviceId } : {}),
          ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
          ...(runtime.networkPolicy
            ? { networkPolicy: runtime.networkPolicy }
            : {}),
        });
      const resolved = await resolveSelectedRepository(
        admin,
        localContext,
        selection,
      );
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
        resolved.identity,
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
          `${teamName(candidate.teamId)} (${candidate.teamId}) — ${resolved.owner}/${resolved.name}`;
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
              suggestedName: resolved.owner,
              noInput: parsed.noInput,
              prompt: ask,
              write,
              ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
            })
          ).id,
          repository: {
            host: "github.com",
            owner: resolved.owner,
            name: resolved.name,
            githubRepositoryId: resolved.identity,
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
      const explicitEnvironmentReference =
        parsed.environment ??
        (parsed.command === "init" ? parsed.positionals[0] : undefined);
      // An explicit reference may be the operator-visible label; resolve it
      // against the Project now so only the stable id reaches the service and
      // the worktree context. A miss fails before any workflow work, leaving
      // the saved selection untouched.
      const explicitEnvironment =
        explicitEnvironmentReference === undefined
          ? undefined
          : await resolveEnvironmentReference(
              admin,
              initializedProject.id,
              explicitEnvironmentReference,
              {
                noInput: parsed.noInput,
                ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
                ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
              },
            );
      const savedEnvironmentId = localContext?.environmentId;
      // Usable means "present and still active"; a missing selection is
      // trivially usable because nothing needs to be re-validated.
      let savedSelectionUsable = savedEnvironmentId === undefined;
      if (
        explicitEnvironmentReference === undefined &&
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
        explicitEnvironment?.id ??
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
        // The verified identity is recorded with the choice so later runs
        // match the local record and skip resolution entirely.
        repositoryRemote: selection.choice.remote,
        repositoryOwner: resolved.owner,
        repositoryName: resolved.name,
        repositoryIdentity: resolved.identity,
      });
    }
    const workflowResult = await runProtectedWorkflow(
      {
        profile,
        credentials: localCredentials(runtime),
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        ...(runtime.networkPolicy
          ? { networkPolicy: runtime.networkPolicy }
          : {}),
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
    if (args.includes("--help") || args.length === 0) {
      // Route --help to the selected command's help when a command is named,
      // so `dotrelay rollback --help` never answers with the everyday list.
      const label = helpLabelFor(helpTopicFor(args));
      const help = label ? renderCommandHelp(label) : renderHelp();
      return {
        exitCode: EXIT_CODES.success,
        stdout: `${help}\n`,
        stderr: "",
      };
    }
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
        : `${errorCard(
            presentationForError(error, {
              debug: args.includes("--debug"),
            }),
          )}\n`,
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
  if (result.exitCode === 0) {
    const displayed = consumeDisplayedRecoveryCodePath();
    if (displayed) await unlink(displayed).catch(() => {});
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (typeof process.stdin.setRawMode === "function")
    process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exit(result.exitCode);
}
