import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type CliDeviceStorage,
  createCliDeviceStorage,
  type DeviceKeyMaterial,
  deviceKeyFingerprint,
  loadDeviceKeyMaterial,
} from "@dotrelay/client";
import { uuidToBytes } from "@dotrelay/contracts";
import {
  archiveEnvironment,
  createEnvironment,
  createStrictJsonClient,
  type EnvironmentSummary,
  findProjectByRepository,
  linkProject,
  listEnvironments,
  listPendingTeamAccess,
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
  ownArguments,
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
  revokeServerSession,
} from "./auth";
import {
  bar,
  bold,
  epilogue,
  errorCard,
  GLYPHS,
  glyph,
  heading,
  type KvRow,
  kv,
  markLine,
  note,
  openRail,
  paint,
  railLines,
  railText,
  stepDone,
  terminalWidth,
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
import { cliDevice } from "./device-proof";
import {
  createFileDeviceRecordStore,
  deviceMetadataPath,
  readDeviceId,
} from "./device-storage";
import {
  CliError,
  capitalize,
  CliInvocationError,
  categoryTitleFor,
  diagnosticForError,
  EXIT_CODES,
  presentationForError,
  sanitizeCliLine,
  sanitizeCliText,
} from "./errors";
import { withGitHubAppInstallHint } from "./github-app";
import {
  createGitTrackingProbe,
  type GitTrackingProbe,
  gitCommand,
  gitEnvironment,
} from "./git-tracking";
import {
  helpLabelFor,
  helpTopicFor,
  renderCommandHelp,
  renderHelp,
  renderPowerHelp,
} from "./help";
import { guidanceFor } from "./guidance";
import { setupHint, setupOrigin } from "./hosted-origin";
import { hardenLocalState } from "./local-state";
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
  rebindServerProfile,
  resolveServerProfile,
  useServerProfile,
  withDefaultProtocol,
} from "./profile";
import {
  backupMetadataContents,
  reselectWorktreeNavigation,
  resetTrustedEnvironmentHistory,
} from "./repair";
import type { TerminalIo } from "./terminal";
import {
  confirmAction,
  rewriteRegion,
  selectOption,
  UNREADABLE_TERMINAL_DETAIL,
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
import { consumeDisplayedRecoveryCode } from "./workflow-account-key";
import { SHARE_PROJECT_KEYS_STEP } from "./workflow-session";
import {
  parseBoundary,
  parseRotationOwed,
  type RotationOwed,
  rotationOwedNotice,
  workspaceBoundaryFields as boundaryFields,
} from "./workflow-core";
import { rotateProjectEpoch } from "./workflow-epoch-rotation";
import { shareProjectKeys } from "./workflow-share-keys";
import { deleteAccount, exportAccount, leaveTeam } from "./workflow-account";
import { declineTeamInvitation } from "./workflow-invitations";
import { listTeamMembers, trustTeamMember } from "./workflow-team";
import {
  type ChildProcessRunner,
  exportEnvironment,
  listEnvironmentVariables,
  runWithEnvironment,
} from "./workflow-values";

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
  /** Starts the command `dotrelay run` wraps; tests substitute their own. */
  readonly spawn?: ChildProcessRunner;
  /**
   * Offer to fix a stopped command and carry on. Defaults to on only when
   * stdin, stdout and stderr are all terminals and CI is not set; --json
   * and --no-input always turn it off.
   */
  readonly guide?: boolean;
  /** Set while a guided fix or resume runs, so the header isn't repeated. */
  readonly nested?: boolean;
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
      gitCommand(["config", "--get-regexp", "^remote\\..*\\.url$"]),
      { env: gitEnvironment(), stdout: "pipe", stderr: "pipe" },
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
      "Couldn't read this repository's Git remotes.",
      {},
      "repository_detection_failed",
    );
  }
};

const defaultWorktreeConfigPath = async (): Promise<string> => {
  try {
    const child = Bun.spawn(gitCommand(["rev-parse", "--git-dir"]), {
      env: gitEnvironment(),
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
    throw new CliInvocationError(
      "Couldn't find a Git repository here. Run this from inside your project's repository.",
    );
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
      `The remote ${selection.choice.remote} points at ${selection.choice.owner}/${selection.choice.name}, but this worktree was set up for ${record.owner}/${record.name}. Point the remote back at ${record.owner}/${record.name}, or switch this worktree to the new repository with dotrelay context --remote ${selection.choice.remote}.`,
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
  if (session === "verified") return { text: "signed in", tone: "brand" };
  if (session === "expired")
    return { text: "expired or revoked", tone: "danger" };
  if (session === "unverified")
    return { text: "signed in, not checked", tone: "warn" };
  return { text: "signed out", tone: "muted" };
};

const statusDeviceLine = (device: string): StatusLine => {
  if (device === "active") return { text: "active", tone: "brand" };
  if (device === "not-active") return { text: "not active", tone: "danger" };
  if (device === "unusable") return { text: "keys unusable", tone: "danger" };
  if (device === "unverified")
    return { text: "last known, not checked", tone: "warn" };
  return { text: "not enrolled", tone: "muted" };
};

// The note names the stage that could not complete; once the service has
// answered one probe it must never be reported as unreachable.
const statusServiceNote = (service: string, origin: string): string | null => {
  const host = origin ? hostOfOrigin(origin) : "The server";
  if (service === "offline") return `Couldn't reach ${host}`;
  if (service === "unavailable")
    return `${host} answered but couldn't check this device`;
  return null;
};

const hostOfOrigin = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const statusNextAction = (value: Record<string, unknown>): string | null => {
  const next = typeof value.nextAction === "string" ? value.nextAction : "none";
  if (next === "none") return null;
  if (next === "run dotrelay login") return "dotrelay login";
  if (next === "run dotrelay device enroll") return "dotrelay device enroll";
  if (next === "run dotrelay device recover") return "dotrelay device recover";
  if (next.startsWith("run dotrelay env use"))
    return "dotrelay env use <environment-id-or-label>";
  if (next.startsWith("run dotrelay setup")) return "dotrelay setup";
  if (next === "retry when the Server Profile is reachable")
    return "dotrelay status";
  if (next === "retry dotrelay status") return "dotrelay status";
  if (next.startsWith("this build targets")) return "dotrelay login";
  return next;
};

// One status row: `server    api.dotrelay.dev      ● trusted`.
const statusRow = (
  key: string,
  value: string | undefined,
  state?: StatusLine,
): string => {
  const shown =
    value === undefined ? paint(GLYPHS.em, "ghost") : sanitizeCliLine(value);
  const head = `${bar()}  ${paint(key.padEnd(10), "faint")}${shown}`;
  if (!state) return head;
  const dot = paint(`${GLYPHS.on} ${state.text}`, state.tone);
  const column = 44;
  const gap = column - (12 + [...(value ?? GLYPHS.em)].length);
  return gap >= 2 && terminalWidth() >= 60
    ? `${head}${" ".repeat(gap)}${dot}`
    : `${head}  ${dot}`;
};

// A profile named after its server's address says nothing the server row
// doesn't already show.
const isDefaultProfileName = (profile: string, origin: string): boolean => {
  try {
    return profile === profileNameFromOrigin(origin);
  } catch {
    return false;
  }
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
  const repository =
    typeof value.repository === "string" ? value.repository : "";
  const environment =
    typeof value.environment === "string"
      ? value.environment
      : typeof value.environmentId === "string"
        ? value.environmentId
        : "";
  const context = [repository, environment].filter(Boolean).join(" · ");
  const lines = [heading("status", context || undefined), bar()];
  const host = origin ? hostOfOrigin(origin) : undefined;
  lines.push(
    statusRow(
      "server",
      host,
      service === "offline"
        ? { text: "unreachable", tone: "warn" }
        : profile && profile !== host && !isDefaultProfileName(profile, origin)
          ? { text: `profile ${profile}`, tone: "faint" }
          : undefined,
    ),
  );
  lines.push(
    statusRow(
      "account",
      typeof value.account === "string" ? value.account : "GitHub",
      statusSessionLine(session),
    ),
  );
  lines.push(statusRow("device", deviceName, statusDeviceLine(device)));
  if (typeof value.projectId === "string")
    lines.push(
      statusRow(
        "project",
        // The repository names the project; the id is the fallback.
        repository
          ? repository.replace(/^github\.com\//, "")
          : abbreviateId(sanitizeCliText(String(value.projectId))),
      ),
    );
  if (environment) {
    const state: StatusLine | undefined =
      value.environmentActive === false
        ? { text: "not active", tone: "warn" }
        : value.environmentUnverified === true
          ? { text: "not checked", tone: "warn" }
          : undefined;
    lines.push(statusRow("env", environment, state));
  }
  lines.push(bar());
  const serviceNote = statusServiceNote(service, origin);
  const next = statusNextAction(value);
  const warnings =
    serviceNote !== null ||
    value.environmentUnverified === true ||
    typeof value.rotationOwedNotice === "string";
  if (serviceNote) lines.push(markLine("warn", paint(serviceNote, "warn")));
  if (value.environmentUnverified === true)
    lines.push(
      markLine("warn", paint("Couldn't check the saved environment", "warn")),
    );
  if (typeof value.rotationOwedNotice === "string")
    lines.push(
      markLine(
        "warn",
        paint(sanitizeCliLine(value.rotationOwedNotice), "warn"),
      ),
    );
  if (next === null && typeof value.hint === "string")
    lines.push(railText(sanitizeCliLine(value.hint)));
  lines.push(
    next !== null
      ? `${paint(GLYPHS.end, "ghost")}  ${paint("next", "faint")}  ${bold(next)}`
      : warnings
        ? paint(GLYPHS.end, "ghost")
        : epilogue("All set"),
  );
  return `${lines.join("\n")}\n`;
};

const renderProfileList = (value: Record<string, unknown>): string => {
  const profiles = Array.isArray(value.profiles) ? value.profiles : [];
  if (profiles.length === 0)
    return `${note(`No servers saved yet. To add one, run ${setupHint}.`)}\n`;
  const rows = profiles.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : "",
      origin: typeof record.origin === "string" ? record.origin : "",
      selected: value.selected === record.name,
    };
  });
  const lines = rows.map((row) => {
    const marker = row.selected
      ? paint(GLYPHS.on, "brand")
      : paint(GLYPHS.off, "faint");
    const name = row.selected ? bold(row.name) : paint(row.name, "muted");
    return `${bar()}  ${marker} ${name}  ${paint(row.origin, "faint")}`;
  });
  return `${lines.join("\n")}\n${paint(GLYPHS.end, "ghost")}\n`;
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
  return `${railLines(kv(rows))}\n${bar()}\n${
    next.length > 0
      ? `${markLine("warn", paint(sanitizeCliText(next), "warn"))}\n${paint(GLYPHS.end, "ghost")}`
      : epilogue("Saved for this worktree")
  }\n`;
};

const renderDeviceResult = (
  command: string,
  value: Record<string, unknown>,
  closing = true,
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
      // The person has to carry this value to this command's --wrapper-id,
      // so the card prints it whole. Other ids on this card are labels and
      // stay short.
      value: value.wrapperId,
      tone: "muted",
    });
  if (typeof value.via === "string")
    rows.push({
      key: "Via",
      value:
        value.via === "recovery-code" ? "recovery code" : "device transfer",
      tone: "accent",
    });
  if (typeof value.transferCode === "string")
    rows.push({
      key: "Transfer code",
      // The person has to carry this value to another device, so the card
      // prints it whole. It ends with the account fingerprint the receiving
      // Device checks. Other ids on this card are labels and stay short.
      value: value.transferCode,
      tone: "accent",
    });
  else if (typeof value.transferId === "string")
    rows.push({
      key: "Transfer ID",
      value: value.transferId,
      tone: "accent",
    });
  if (typeof value.accountFingerprint === "string")
    rows.push({
      key: "Account",
      value: value.accountFingerprint,
      tone: "muted",
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
  const lines: string[] = [];
  if (rows.length > 0) lines.push(railLines(kv(rows)), bar());
  lines.push(closingLines(message.length > 0 ? message : "Done", closing));
  return `${lines.join("\n")}\n`;
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
  if (rows.length === 0) return "Done\n";
  return `${kv(rows)}\n`;
};

// A result message such as "Wrote 14 values to .env. The old file is kept
// at .env.previous." closes the rail: the first sentence (or clause, in the
// older "x; y" form) is the result, the rest are notes above it. A dot only
// ends a sentence before a space and a capital, so file names, origins and
// version numbers stay whole.
const closingLines = (message: string, closing = true): string => {
  const [first = "", ...rest] = sanitizeCliText(message)
    .split(/; |(?<=[.!?])\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const result = `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
  return [
    ...rest.map((part) =>
      railText(`${part.charAt(0).toUpperCase()}${part.slice(1)}`, "faint"),
    ),
    closing ? epilogue(result) : `${stepDone(result)}\n${bar()}`,
  ].join("\n");
};

const recoveryCodeBlock = (code: string, warning: string): string =>
  [
    markLine(
      "warn",
      paint("Save your recovery code now. It's shown once.", "warn"),
    ),
    bar(),
    `${bar()}    ${bold(sanitizeCliLine(code))}`,
    bar(),
    railText(
      "If you lose this code and every unlocked device, nobody can decrypt your values, DotRelay included.",
      "muted",
    ),
    ...(warning ? [railText(warning, "faint")] : []),
    bar(),
  ].join("\n");

const renderSuccess = (
  parsed: ParsedArguments,
  value: Record<string, unknown>,
  options: Readonly<{
    /** False when a guided fix ran and the original command carries on. */
    readonly closing?: boolean;
  }> = {},
): string => {
  const closing = options.closing ?? true;
  if (parsed.json) return json({ ok: true, ...value });
  if ("stdout" in value && typeof value.stdout === "string")
    return value.stdout;
  if (parsed.command === "status") return renderStatusCard(value);
  if (parsed.command === "profile" && parsed.subcommand === "list")
    return renderProfileList(value);
  if (parsed.command === "context") return renderContextCard(value);
  if (parsed.command === "device" && parsed.subcommand)
    return renderDeviceResult(parsed.subcommand, value, closing);
  if (parsed.command === "login" || parsed.command === "setup") {
    const code =
      typeof value.recoveryCode === "string" ? value.recoveryCode : "";
    const result = sanitizeCliLine(String(value.message ?? "Signed in"));
    const advice =
      !code && typeof value.nextAction === "string"
        ? railText(sanitizeCliText(value.nextAction), "faint")
        : null;
    return `${[
      ...(code ? [recoveryCodeBlock(code, "")] : []),
      ...(advice ? [advice] : []),
      closing ? epilogue(result) : `${stepDone(result)}\n${bar()}`,
    ].join("\n")}\n`;
  }
  if (typeof value.message === "string") {
    if (parsed.command === "profile" && parsed.subcommand === "use")
      return `${closingLines(`Now using ${sanitizeCliLine(String(value.profile))}`, closing)}\n`;
    if (parsed.command === "env" && parsed.subcommand === "use")
      return `${closingLines(
        `Now using environment ${sanitizeCliLine(String(value.environment ?? value.environmentId ?? "the selection"))}`,
        closing,
      )}\n`;
    if (parsed.command === "project" && parsed.subcommand === "link")
      return `${closingLines(`Linked ${sanitizeCliLine(String(value.repository ?? "the repository"))} to this worktree`, closing)}\n`;
    if (HUMAN_HEADING_COMMANDS.has(parsed.command))
      return `${closingLines(
        typeof value.summary === "string" ? value.summary : value.message,
        closing,
      )}\n`;
    return `${sanitizeCliText(value.message)}\n`;
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
    "dotrelay login signs you in with GitHub and enrolls this machine as a device.",
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
    device: cliDevice({
      pin: profile.pin,
      credentials,
      stateDirectory,
      deviceId,
      ...(runtime.deviceStorage
        ? { deviceStorage: runtime.deviceStorage }
        : {}),
    }),
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
  offline: "Can't reach the server",
  stalled: "The server stopped responding",
  // A rate limit or a 5xx answer: both are transient server conditions.
  server: "The server is busy or briefly down",
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
    `${retryReasonPhrase[progress.reason]}. Retry ${progress.maxAttempts !== undefined ? `${progress.attempt} of ${progress.maxAttempts}` : progress.attempt} in ${Math.max(1, Math.ceil(progress.nextDelayMs / 1000))}s`;
  const renderLoginCard = (hint: string): string => {
    const [url, code, expiry] = waitingBody;
    const lines = [
      `${bar()}  ${paint("open", "faint")}  ${paint(url ?? "", "info")}`,
    ];
    if (code)
      lines.push(
        `${bar()}  ${paint("code", "faint")}  ${bold(code)}${expiry ? `  ${paint(`expires in ${expiry}`, "ghost")}` : ""}`,
      );
    if (openFailed)
      lines.push(
        railText(
          "Couldn't open a browser here. Open the link above in any browser.",
          "warn",
        ),
      );
    lines.push(bar(), hint);
    return lines.join("\n");
  };
  const renderWaiting = (): void => {
    const elapsed = elapsedSeconds();
    const spinner =
      ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][
        Math.floor(policy.now() / 100) % 10
      ] ?? "⠋";
    const hint =
      retryState !== null && retryState.kind === "retry"
        ? markLine("warn", paint(retryLine(retryState), "warn"))
        : markLine(
            "info",
            manualPath
              ? "Open the link above to sign in with GitHub"
              : "Waiting for GitHub in your browser",
            elapsed >= 1 ? describeDuration(elapsed) : undefined,
          ).replace(
            /^\S+/,
            outputIsTty && !manualPath
              ? paint(spinner, "brand")
              : glyph("info"),
          );
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
    tickTimer = setInterval(() => renderWaiting(), 100);
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
      else output.write("The server is back. Still waiting for sign-in.\n");
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
                    "Couldn't open the sign-in page in a browser. Open verificationUri from the device_authorization event instead.",
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
  const step = (label: string): void => {
    if (!parsed.json) output.write(`${stepDone(label)}\n${bar()}\n`);
  };
  step(`Signed in with GitHub on ${profile.name}`);
  const enrollment = await enrollFirstDevice(
    deviceWorkflowOptions(parsed, runtime, profile, credentials),
  ).catch(
    async (
      error: unknown,
    ): Promise<Awaited<ReturnType<typeof enrollFirstDevice>>> => {
      if (!(error instanceof CliError) || error.code !== "state_conflict")
        throw error;
      if (parsed.noInput)
        throw new CliError(
          "authentication",
          "You're signed in, but this machine can't read your values yet. Enroll it with dotrelay device enroll and approve it from a device you already use, or run dotrelay device recover --recovery-code-file <path> if you've lost your devices.",
          {},
          "account_key_not_unlocked",
        );
      const recovered = await recoverAccountKey(
        deviceWorkflowOptions(parsed, runtime, profile, credentials),
        {},
      );
      return { deviceId: recovered.deviceId, active: true, existing: false };
    },
  );
  step(
    enrollment.existing
      ? "This device was already enrolled"
      : `Enrolled this device${enrollment.deviceName ? ` as ${sanitizeCliLine(enrollment.deviceName)}` : ""}`,
  );
  const recovery = await setupDeviceAccountKey(
    deviceWorkflowOptions(parsed, runtime, profile, credentials),
  ).catch((error: unknown) => {
    if (
      error instanceof CliError &&
      error.code === "account_key_already_exists"
    )
      return null;
    throw error;
  });
  // OAuth identification alone is not a completed DotRelay login. A new
  // machine joining an existing account must open the same Account Master
  // Key before setup reports success or offers protected commands.
  if (recovery === null && parsed.noInput)
    throw new CliError(
      "authentication",
      "You're signed in and this device is enrolled, but it doesn't have your account key yet. To finish, run dotrelay device recover --recovery-code-file <path>, or send the key from another device.",
      {},
      "account_key_not_unlocked",
    );
  const recovered =
    recovery === null
      ? await recoverAccountKey(
          deviceWorkflowOptions(parsed, runtime, profile, credentials),
          {},
        )
      : null;
  step(
    recovered
      ? "Account key unlocked on this device"
      : "Account key ready on this device",
  );
  return {
    profile: profile.name,
    userCode: login.userCode,
    verificationUri: login.verificationUri,
    deviceId: enrollment.deviceId,
    device: enrollment.active ? "enrolled" : "not enrolled",
    ...(enrollment.deviceName ? { deviceName: enrollment.deviceName } : {}),
    ...(recovery?.recoveryCode ? { recoveryCode: recovery.recoveryCode } : {}),
    ...(recovery?.wrapperId ? { wrapperId: recovery.wrapperId } : {}),
    message: recovered
      ? `Signed in to ${profile.name}. This device is enrolled and can read your values.`
      : enrollment.existing
        ? `Signed in to ${profile.name}. This device was already enrolled.`
        : `Signed in to ${profile.name}. This device is enrolled.`,
    nextAction: recovery?.recoveryCode
      ? "Save the recovery code now. It's shown once. Without it or another unlocked device, nobody can decrypt your values."
      : recovered
        ? "This device can read your values. Keep your recovery code somewhere safe for setting up other devices."
        : "Keep your recovery code somewhere safe. If you've lost it and this device is still unlocked, run dotrelay device backup to make a new one. Signing in with GitHub can't recover your values.",
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
  // Whether status runs inside a Git worktree at all, so the repository
  // hint is only offered where init or pull could act.
  let inWorktree = false;
  try {
    worktreeContext = await readWorktreeContext(
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath()),
    );
    inWorktree = true;
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
  let accountName: string | undefined;
  let sessionState: "verified" | "expired" | "unverified" | "not-stored" =
    sessionToken ? "unverified" : "not-stored";
  let deviceState:
    "active" | "not-active" | "unusable" | "unverified" | "not-enrolled" =
    storedDeviceId
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
  let rotationOwed: RotationOwed | null = null;
  if (sessionToken) {
    const admin =
      runtime.admin ??
      createStrictJsonClient(pin, credentials, {
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        ...(runtime.networkPolicy
          ? { networkPolicy: runtime.networkPolicy }
          : { networkPolicy: probeNetworkPolicy }),
        ...(storedDeviceId
          ? {
              device: cliDevice({
                pin,
                credentials,
                stateDirectory,
                deviceId: storedDeviceId,
                ...(runtime.deviceStorage
                  ? { deviceStorage: runtime.deviceStorage }
                  : {}),
              }),
            }
          : {}),
      });
    try {
      const signedIn = await admin.get("/api/v1/session", [
        "authenticated",
        "user",
      ]);
      const user = signedIn.user as { name?: unknown } | null | undefined;
      if (typeof user?.name === "string" && user.name.trim())
        accountName = user.name.trim();
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
            rotationOwed = parseRotationOwed(environmentRecord.rotationOwed);
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
          deviceState = deviceKeysUsable ? "unverified" : "unusable";
        } else if (
          error instanceof CliError &&
          error.code === "device_not_active"
        ) {
          // The service refused this Device a proof: it is not active.
          deviceState = "not-active";
          service = "rejected";
        } else if (
          error instanceof CliError &&
          (error.code === "device_bundle_invalid" ||
            error.code === "device_bundle_missing")
        ) {
          // The service accepted the session but not this bundle's key.
          deviceState = "unusable";
          service = "verified";
        } else {
          service = isServiceUnreachable(error) ? "offline" : "unavailable";
          deviceState = deviceKeysUsable ? "unverified" : "unusable";
        }
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
  const repository =
    context?.repositoryOwner && context.repositoryName
      ? `github.com/${context.repositoryOwner}/${context.repositoryName}`
      : null;
  // Connected but this worktree is not linked yet: say what to run here.
  const hint =
    nextAction === "none" && inWorktree && context?.projectId === undefined
      ? "This repository isn't linked on this machine yet. Run dotrelay pull if a teammate already published it, or dotrelay init to publish its .env."
      : null;
  return {
    profile: selected.name,
    origin: selected.origin,
    service,
    session: sessionState,
    ...(accountName ? { account: accountName } : {}),
    device: deviceState,
    ...(deviceName ? { deviceName } : {}),
    nextAction,
    ...(hint ? { hint } : {}),
    ...(repository ? { repository } : {}),
    ...(context ? { projectId: context.projectId } : {}),
    ...(contextEnvironmentId
      ? {
          environmentId: contextEnvironmentId,
          ...(environmentLabel ? { environment: environmentLabel } : {}),
        }
      : {}),
    ...(environmentActive !== null ? { environmentActive } : {}),
    ...(environmentUnverified ? { environmentUnverified: true } : {}),
    ...(rotationOwed
      ? { rotationOwed, rotationOwedNotice: rotationOwedNotice(rotationOwed) }
      : {}),
  };
};

// init on a Project created in this same run: the service created a
// "development" Environment with the Project, but the operator named another
// label. That label becomes the Environment published into, and the empty
// default is archived (best effort) so teammates are not later asked to
// choose between it and the real one.
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const initialEnvironmentFor = async (
  admin: StrictJsonClient,
  project: Awaited<ReturnType<typeof linkProject>>,
  label: string,
): Promise<EnvironmentSummary> => {
  const created = await createEnvironment(admin, project.id, label);
  const placeholder = project.environment;
  if (
    placeholder &&
    placeholder.id !== created.id &&
    placeholder.currentHeadId === null
  )
    await archiveEnvironment(admin, placeholder.id).catch(() => undefined);
  return created;
};

// The worktree's linked Project for commands that act on its Environments.
// A missing session is reported before a missing link, since resolving the
// link needs one.
const requireWorktreeProject = async (
  runtime: CliRuntime,
  profile: CliServerProfile,
): Promise<
  Readonly<{ contextPath: string; context: WorktreeContext; projectId: string }>
> => {
  const contextPath =
    runtime.worktreeConfig ?? (await defaultWorktreeConfigPath());
  const context = await readWorktreeContext(contextPath);
  if (!context || context.projectId === undefined) {
    const token = await createSessionStore(localCredentials(runtime)).get(
      profile.pin,
    );
    if (!token)
      throw new CliError(
        "authentication",
        "You're not signed in to this server. Run dotrelay login.",
        {},
        "authentication_required",
      );
    throw new CliInvocationError(
      "This repository isn't linked to a project yet. Run dotrelay pull if a teammate already published it, or dotrelay init to publish its .env.",
    );
  }
  if (context.serverProfileId !== profile.pin.serverProfileId)
    throw new CliInvocationError(
      "This repository is linked to a project on a different server. Pick that server with --profile <name>.",
    );
  return { contextPath, context, projectId: context.projectId };
};

const renderEnvironmentList = (
  environments: readonly EnvironmentSummary[],
  selectedId: string | undefined,
): string => {
  if (environments.length === 0)
    return `${note("This project has no environments yet. Create one with dotrelay env create <label>.")}\n`;
  const width = Math.max(...environments.map((entry) => entry.label.length));
  const lines = environments.map((entry) => {
    const selected = entry.id === selectedId;
    const marker = selected ? paint("▸", "brand") : paint("·", "ghost");
    const label = sanitizeCliLine(entry.label).padEnd(width);
    const state = [
      entry.lifecycle === "archived" ? "archived" : null,
      entry.currentHeadId === null ? "nothing published yet" : null,
      selected ? "selected" : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
    return `${bar()}  ${marker}  ${selected ? bold(label) : label}  ${paint(entry.id, "faint")}${state ? `  ${paint(state, "muted")}` : ""}`;
  });
  return `${lines.join("\n")}\n${paint(GLYPHS.end, "ghost")}\n`;
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
  "list",
]);

const execute = async (
  args: readonly string[],
  runtime: CliRuntime,
): Promise<
  Readonly<{
    value: Record<string, unknown> | { stdout: string };
    /** Set by run: the wrapped command's exit code. */
    exitCode?: number;
  }>
> => {
  const parsed = parseArguments(
    args,
    runtime.stdoutIsTerminal === undefined
      ? {}
      : { stdoutIsTerminal: runtime.stdoutIsTerminal },
  );
  if (
    !parsed.json &&
    !runtime.nested &&
    HUMAN_HEADING_COMMANDS.has(parsed.command)
  ) {
    const output = runtime.terminal?.output ?? process.stderr;
    output.write(
      openRail(
        parsed.subcommand
          ? `${parsed.command} ${parsed.subcommand}`
          : parsed.command,
      ),
    );
  }
  if (parsed.command === "help") {
    if (parsed.positionals.length === 0)
      return { value: { stdout: `${renderPowerHelp()}\n` } };
    const topic = parsed.positionals;
    const label = helpLabelFor(topic);
    if (!label)
      throw new CliInvocationError(
        `DotRelay has no ${topic.join(" ")} command.\nUsage: dotrelay help [<command>]`,
      );
    return { value: { stdout: `${renderCommandHelp(label)}\n` } };
  }
  const catalogPath = runtime.profilePath ?? profileCatalogPath();
  // Keys and sessions live beside the catalog: restrict the directory and
  // the files the CLI keeps there before any of them is read or written.
  await hardenLocalState(runtime.stateDirectory ?? dirname(catalogPath));
  const store = createFileProfileCatalog(catalogPath);
  if (parsed.command === "setup") {
    // The address goes to discovery as typed: without a scheme, a loopback
    // host such as localhost falls back to plain HTTP when HTTPS can't be
    // reached, which only works if discovery sees that no scheme was given.
    const requested = parsed.positionals[0] ?? setupOrigin;
    const origin = withDefaultProtocol(requested);
    const catalog = await store.read();
    const plainHttp = origin.replace(/^https:/, "http:");
    const existing = catalog.profiles.find(
      (profile) => profile.origin === origin || profile.origin === plainHttp,
    );
    const profile = await addServerProfile(
      store,
      existing?.name ?? profileNameFromOrigin(origin),
      requested,
      {
        ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        ...(runtime.networkPolicy
          ? { networkPolicy: runtime.networkPolicy }
          : { networkPolicy: probeNetworkPolicy }),
      },
    );
    const selected = (await store.read()).selected;
    if (selected !== profile.name) await useServerProfile(store, profile.name);
    return { value: await loginAndEnroll(parsed, runtime, profile) };
  }
  if (parsed.command === "profile" && parsed.subcommand === "add") {
    const [name, origin] = parsed.positionals;
    if (!name || !origin)
      throw new Error(
        "dotrelay profile add needs a profile name and the server's address.",
      );
    const profile = await addServerProfile(store, name, origin, {
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      ...(runtime.networkPolicy
        ? { networkPolicy: runtime.networkPolicy }
        : { networkPolicy: probeNetworkPolicy }),
    });
    return {
      value: {
        profile: profile.name,
        origin: profile.origin,
        message: `Saved ${profile.origin}`,
      },
    };
  }
  if (parsed.command === "profile" && parsed.subcommand === "rebind") {
    const [name, origin] = parsed.positionals;
    if (!name || !origin)
      throw new CliInvocationError(
        "dotrelay profile rebind needs a profile name and the server's address.",
      );
    const profilePath = runtime.profilePath ?? profileCatalogPath();
    const stateDirectory = runtime.stateDirectory ?? dirname(profilePath);
    const output = runtime.terminal?.output ?? process.stderr;
    const rebound = await rebindServerProfile(store, name, origin, {
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      ...(runtime.networkPolicy
        ? { networkPolicy: runtime.networkPolicy }
        : { networkPolicy: probeNetworkPolicy }),
      approve: async (statement) => {
        output.write(`${statement}\n`);
        if (parsed.force) return true;
        if (parsed.noInput) return false;
        if (runtime.confirm) return runtime.confirm(statement);
        return confirmAction(statement, {
          ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
          ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
          silent: true,
        });
      },
      catalogContents: async () => {
        try {
          return await readFile(profilePath, "utf8");
        } catch {
          return "";
        }
      },
      backupCatalog: (contents) =>
        backupMetadataContents(stateDirectory, "profile-catalog", contents),
    });
    if (!rebound.identityChanged)
      return {
        value: {
          profile: rebound.profile.name,
          origin: rebound.profile.origin,
          serverProfileId: rebound.profile.pin.serverProfileId,
          identityChanged: false,
          message:
            "The server's identity hasn't changed, so there's nothing to rebind.",
        },
      };
    const resetCount =
      rebound.previous === null
        ? 0
        : await resetTrustedEnvironmentHistory(
            stateDirectory,
            rebound.previous.serverProfileId,
          );
    return {
      value: {
        profile: rebound.profile.name,
        origin: rebound.profile.origin,
        serverProfileId: rebound.profile.pin.serverProfileId,
        identityChanged: true,
        backupPath: rebound.backupPath,
        historyResetCount: resetCount,
        message: `${rebound.statement} The old profile list is backed up at ${rebound.backupPath}. Cleared the trusted history for ${resetCount} environment${resetCount === 1 ? "" : "s"}.`,
      },
    };
  }
  if (parsed.command === "profile" && parsed.subcommand === "use") {
    const name = parsed.positionals[0];
    if (!name) throw new Error("dotrelay profile use needs a profile name.");
    const profile = await useServerProfile(store, name);
    return {
      value: {
        profile: profile.name,
        origin: profile.origin,
        selected: true,
        message: "selected",
      },
    };
  }
  if (parsed.command === "profile" && parsed.subcommand === "list") {
    const catalog = await store.read();
    return {
      value: {
        profiles: catalog.profiles.map(({ name, origin }) => ({
          name,
          origin,
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
            : `run ${setupHint}`,
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
    const sessions = createSessionStore(localCredentials(runtime));
    const token = await sessions.get(profile.pin);
    // The server-side revocation is best effort; the local copy is removed
    // either way, and the result says which of the two happened.
    const serverSession = token
      ? await revokeServerSession(profile.pin, token, {
          ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
          networkPolicy: runtime.networkPolicy ?? probeNetworkPolicy,
        })
      : "none";
    await sessions.remove(profile.pin);
    const name = sanitizeCliLine(profile.name);
    const message =
      serverSession === "revoked"
        ? `Signed out of ${name}. The session was revoked on the server and removed from this machine.`
        : serverSession === "already-ended"
          ? `Signed out of ${name}. The server session had already ended, and the copy on this machine was removed.`
          : serverSession === "unreachable"
            ? `Removed the session for ${name} from this machine. Couldn't reach the server, so the session wasn't revoked there. It expires on its own.`
            : `No session was saved for ${name}, so there was nothing to sign out of.`;
    return {
      value: {
        profile: profile.name,
        loggedOut: true,
        serverSession,
        message,
      },
    };
  }
  if (parsed.command === "context" && parsed.subcommand === "reselect") {
    const profilePath = runtime.profilePath ?? profileCatalogPath();
    const stateDirectory = runtime.stateDirectory ?? dirname(profilePath);
    const contextPath =
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath());
    const output = runtime.terminal?.output ?? process.stderr;
    const reselected = await reselectWorktreeNavigation({
      contextPath,
      stateDirectory,
      approve: async (statement) => {
        output.write(`${statement}\n`);
        if (parsed.force) return true;
        if (parsed.noInput) return false;
        if (runtime.confirm) return runtime.confirm(statement);
        return confirmAction(statement, {
          ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
          ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
          silent: true,
        });
      },
    });
    return {
      value: {
        backupPath: reselected.backupPath,
        removed: reselected.removed,
        projectCleared: reselected.projectCleared,
        environmentCleared: reselected.environmentCleared,
        message: reselected.removed
          ? `Removed this worktree's broken context. A backup is at ${reselected.backupPath}. Device keys and trusted revision history were kept.`
          : `Cleared the project and environment selection. A backup is at ${reselected.backupPath}. Device keys and trusted revision history were kept.`,
      },
    };
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
        "This repository's saved context is for a different server. Pick that server with --profile <name>.",
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
                "Run dotrelay login to sign in and enroll this device, so DotRelay can verify this repository with GitHub.",
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
  if (parsed.command === "team" && parsed.subcommand === "list") {
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    const admin = await createAdminClient(
      runtime,
      profile,
      localCredentials(runtime),
    );
    const teams = await listTeams(admin);
    // Pending access is extra context; an older service without the
    // invitation listing still answers the Team list.
    const pending = await listPendingTeamAccess(admin).catch(() => null);
    const row = (name: string, detail: string): string =>
      `${bar()}  ${paint(GLYPHS.on, "brand")} ${bold(sanitizeCliLine(name))}  ${paint(detail, "faint")}`;
    const lines = [
      openRail("team list").trimEnd(),
      ...(teams.length === 0
        ? [note("You're not an active member of any team yet.")]
        : teams.map((team) => row(team.name, team.id))),
      ...(pending?.pendingMemberships.length
        ? [
            bar(),
            note(
              'Joined, waiting for an owner or admin to choose "Share project keys" for you:',
              "warn",
            ),
            ...pending.pendingMemberships.map((team) =>
              row(team.name, team.id),
            ),
          ]
        : []),
      ...(pending?.invitations.length
        ? [
            bar(),
            note("Invitations to accept in the web app", "warn"),
            railText(
              "To turn one down, run dotrelay team decline <invitation-id>.",
            ),
            ...pending.invitations.map((invitation) =>
              row(invitation.name, `invitation ${invitation.invitationId}`),
            ),
          ]
        : []),
      paint(GLYPHS.end, "ghost"),
    ];
    return {
      value: {
        profile: profile.name,
        teams,
        ...(pending
          ? {
              pendingMemberships: pending.pendingMemberships,
              invitations: pending.invitations,
            }
          : {}),
        ...(parsed.json ? {} : { stdout: `${lines.join("\n")}\n` }),
      },
    };
  }
  if (parsed.command === "account") {
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    const options = deviceWorkflowOptions(
      parsed,
      runtime,
      profile,
      localCredentials(runtime),
    );
    if (parsed.subcommand === "delete")
      return { value: await deleteAccount(options) };
    const exported = await exportAccount(options, parsed);
    // Without --output the export itself is the output.
    return {
      value:
        parsed.output || parsed.json
          ? exported
          : { stdout: `${JSON.stringify(exported, null, 2)}\n` },
    };
  }
  if (parsed.command === "team") {
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    const credentials = localCredentials(runtime);
    const stateDirectory =
      runtime.stateDirectory ??
      dirname(runtime.profilePath ?? profileCatalogPath());
    const options = {
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
    return {
      value:
        parsed.subcommand === "trust"
          ? await trustTeamMember(options, parsed)
          : parsed.subcommand === "share-keys"
            ? await shareProjectKeys(options, parsed)
            : parsed.subcommand === "decline"
              ? await declineTeamInvitation(options, parsed)
              : parsed.subcommand === "leave"
                ? await leaveTeam(options, parsed)
                : await listTeamMembers(options, parsed),
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
          "dotrelay project link needs --team <team-id>.\nUsage: dotrelay project link --team <team-id>",
        );
      })();
    const contextPath =
      runtime.worktreeConfig ?? (await defaultWorktreeConfigPath());
    const context = await readStoredWorktreeContext(contextPath);
    const credentials = localCredentials(runtime);
    // Verify the enrolled Device before offering the repository picker, so
    // a missing enrollment is reported instead of prompting first.
    const admin = await createAdminClient(runtime, profile, credentials);
    const selection = await selectGitHubRepository(
      await (runtime.readGitRemotes ?? readGitRemotes)(),
      repositorySelectionOptions(parsed, runtime, context),
    );
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
    const credentials = localCredentials(runtime);
    if (!context || context.projectId === undefined) {
      // Environment resolution needs a signed-in session, so a missing
      // session is reported before a missing link.
      const token = await createSessionStore(credentials).get(profile.pin);
      if (!token)
        throw new CliError(
          "authentication",
          "You're not signed in to this server. Run dotrelay login.",
          {},
          "authentication_required",
        );
      throw new CliInvocationError(
        "This repository isn't linked to a project yet. Link it with dotrelay project link --team <team-id> before you choose an environment.",
      );
    }
    if (context.serverProfileId !== profile.pin.serverProfileId)
      throw new CliInvocationError(
        "This repository is linked to a project on a different server. Pick that server with --profile <name>.",
      );
    const environmentReference = parsed.environment ?? parsed.positionals[0];
    if (!environmentReference)
      throw new Error("dotrelay env use needs an environment id or label.");
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
        environment: environment.label,
        selected: true,
        message: "selected",
      },
    };
  }
  if (
    parsed.command === "env" &&
    (parsed.subcommand === "list" || parsed.subcommand === "create")
  ) {
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    const { context, projectId } = await requireWorktreeProject(
      runtime,
      profile,
    );
    const admin = await createAdminClient(
      runtime,
      profile,
      localCredentials(runtime),
    );
    if (parsed.subcommand === "create") {
      const label = parsed.positionals[0] ?? "";
      const existing = (await listEnvironments(admin, projectId)).find(
        (entry) => entry.label === label.trim() && entry.lifecycle === "active",
      );
      const environment =
        existing ?? (await createEnvironment(admin, projectId, label));
      return {
        value: {
          profile: profile.name,
          projectId,
          environmentId: environment.id,
          environment: environment.label,
          created: existing === undefined,
          message:
            existing === undefined
              ? `Created environment ${sanitizeCliLine(environment.label)} (${environment.id}). Switch to it with dotrelay env use ${environment.label}, or push to it with dotrelay push --environment ${environment.label}.`
              : `Environment ${sanitizeCliLine(environment.label)} already exists (${environment.id}), so nothing was created.`,
        },
      };
    }
    const environments = await listEnvironments(admin, projectId);
    return {
      value: {
        profile: profile.name,
        projectId,
        environments: environments.map((entry) => ({
          id: entry.id,
          label: entry.label,
          lifecycle: entry.lifecycle,
          published: entry.currentHeadId !== null,
          selected: entry.id === context.environmentId,
        })),
        ...(parsed.json
          ? {}
          : {
              stdout: renderEnvironmentList(
                environments,
                context.environmentId,
              ),
            }),
      },
    };
  }
  if (parsed.command === "device" && parsed.subcommand === "list") {
    const profile = await resolveServerProfile(
      store,
      parsed.profile,
      profileOptions(runtime),
    );
    const admin = await createAdminClient(
      runtime,
      profile,
      localCredentials(runtime),
    );
    const boundary = parseBoundary(
      await admin.get("/api/v1/workspace/boundary", boundaryFields),
    );
    // This Device's key fingerprint comes from its own keys, never from
    // the service: another Device compares it before sending this one the
    // account key (ADR 0022).
    const fingerprint =
      boundary.device.active && boundary.device.id
        ? await (async () => {
            try {
              const storage =
                runtime.deviceStorage ??
                createCliDeviceStorage(profile.pin, localCredentials(runtime), {
                  recordStore: createFileDeviceRecordStore(
                    runtime.stateDirectory ??
                      dirname(runtime.profilePath ?? profileCatalogPath()),
                  ),
                });
              const keys = await loadDeviceKeyMaterial(
                await storage.load({
                  pin: profile.pin,
                  deviceId: uuidToBytes(boundary.device.id ?? ""),
                }),
              );
              if (!keys.encryptionPublicKey || !keys.signingPublicKey)
                return null;
              const raw = async (key: CryptoKey) =>
                new Uint8Array(await crypto.subtle.exportKey("raw", key));
              return await deviceKeyFingerprint({
                encryptionPublicKey: await raw(keys.encryptionPublicKey),
                signingPublicKey: await raw(keys.signingPublicKey),
              });
            } catch {
              return null;
            }
          })()
        : null;
    const devices = [
      ...(boundary.device.active && boundary.device.id
        ? [
            {
              id: boundary.device.id,
              name: boundary.device.name ?? null,
              current: true,
              ...(fingerprint ? { fingerprint } : {}),
            },
          ]
        : []),
      ...boundary.peerDevices.map((peer) => ({
        id: peer.id,
        name: peer.name ?? null,
        current: false,
      })),
    ];
    const lines = devices.map(
      (device) =>
        `${bar()}  ${device.current ? paint("▸", "brand") : paint("·", "ghost")}  ${sanitizeCliLine(device.name ?? "unnamed device")}  ${paint(device.id, "faint")}${device.current ? `  ${paint("this device", "muted")}` : ""}${
          "fingerprint" in device && device.fingerprint
            ? `\n${bar()}     ${paint(`key fingerprint ${device.fingerprint}`, "muted")}`
            : ""
        }`,
    );
    return {
      value: {
        profile: profile.name,
        devices,
        ...(parsed.json
          ? {}
          : {
              stdout:
                devices.length === 0
                  ? `${note("No active devices. Run dotrelay login to enroll this machine.")}\n`
                  : `${lines.join("\n")}\n${paint(GLYPHS.end, "ghost")}\n`,
            }),
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
      "DotRelay has no such device command. Run dotrelay help device.",
    );
  }
  const protectedCommands = new Set([
    "init",
    "push",
    "pull",
    "diff",
    "history",
    "rollback",
    "run",
    "export",
    "list",
  ]);
  if (protectedCommands.has(parsed.command)) {
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
        `With --no-input, dotrelay ${parsed.command} needs --environment <environment-id-or-label>.`,
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
          ...(deviceId
            ? {
                device: cliDevice({
                  pin: profile.pin,
                  credentials,
                  stateDirectory,
                  deviceId,
                  ...(runtime.deviceStorage
                    ? { deviceStorage: runtime.deviceStorage }
                    : {}),
                }),
              }
            : {}),
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
          throw new CliInvocationError(
            "You're not an active member of that team. Run dotrelay team list to see your teams.",
          );
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
          `${teamName(candidate.teamId)} (${candidate.teamId}) · ${resolved.owner}/${resolved.name}`;
        if (parsed.noInput)
          throw new CliError(
            "invocation",
            `More than one project is linked to this GitHub repository. Pass --team <team-id> to pick one:\n${resolution.candidates
              .map((candidate, index) => `${index + 1}. ${label(candidate)}`)
              .join("\n")}`,
            {},
            "project_ambiguous",
          );
        const selectedId = await selectOption(
          "Which project?",
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
          throw new CliInvocationError(
            "Choose one of the projects in the list.",
          );
        existingProject = selected;
      }
      // The Project lookup only spans active Memberships, so a User who
      // accepted an invitation but has no keys yet sees no Project at all.
      // Say so instead of "not linked" (or, for init and push, instead of
      // creating a second Team and Project for the same Repository).
      if (
        !existingProject &&
        resolution.candidates.length === 0 &&
        !explicitTeamId
      ) {
        const pending = await listPendingTeamAccess(admin).catch(() => null);
        const waiting = pending?.pendingMemberships ?? [];
        const invited = pending?.invitations ?? [];
        if (waiting.length > 0)
          throw new CliError(
            "authentication",
            [
              `You joined ${waiting.map((team) => sanitizeCliLine(team.name)).join(", ")}, but nobody has shared its project keys with you yet, so you can't see this repository's project.`,
              SHARE_PROJECT_KEYS_STEP,
              "Then run this command again. To publish this repository in a different team instead, pass --team <team-id>.",
            ].join("\n"),
            {},
            "membership_pending",
          );
        if (
          invited.length > 0 &&
          parsed.command !== "init" &&
          parsed.command !== "push"
        )
          throw new CliError(
            "authentication",
            [
              `You have an invitation to ${invited.map((team) => sanitizeCliLine(team.name)).join(", ")} that you haven't accepted yet.`,
              "Accept it in the DotRelay web app, then ask a team owner or admin to share the project keys with you.",
              "Then run this command again.",
            ].join("\n"),
            {},
            "membership_pending",
          );
      }
      if (
        !existingProject &&
        parsed.command !== "init" &&
        parsed.command !== "push"
      )
        throw new CliError(
          "invocation",
          "This GitHub repository isn't linked to a project you can access. If a teammate published it, ask a team owner or admin to invite you and share the project keys with you. To publish it yourself, run dotrelay init.",
          {},
          "project_not_linked",
        );
      const ask = async (question: string): Promise<string> => {
        if (runtime.prompt) return runtime.prompt(question);
        const { readTerminalLine } = await import("./terminal");
        try {
          return await readTerminalLine(
            `${glyph("info")}  ${question}`,
            runtime.terminal,
          );
        } catch {
          throw new CliInvocationError(UNREADABLE_TERMINAL_DETAIL);
        }
      };
      const write = (message: string): void => {
        const output = runtime.terminal?.output ?? process.stderr;
        output.write(`${railText(message.trimEnd())}\n`);
      };
      const explicitEnvironmentReference =
        parsed.environment ??
        (parsed.command === "init" ? parsed.positionals[0] : undefined);
      const initializedProject =
        existingProject ??
        (await linkProject(admin, {
          // init names the new Project's first Environment directly.
          ...(parsed.command === "init" &&
          explicitEnvironmentReference !== undefined &&
          !uuidPattern.test(explicitEnvironmentReference)
            ? { environmentLabel: explicitEnvironmentReference }
            : {}),
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
      if (existingProject === null && !parsed.json)
        write(
          `Created a project for ${sanitizeCliLine(`${resolved.owner}/${resolved.name}`)}.\n`,
        );
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
            ).catch((error: unknown) =>
              // init on a Project this run created: the named label becomes
              // its first Environment instead of failing as not found (the
              // Project was created with it, so this only runs when the
              // link returned a Project that already existed).
              existingProject === null &&
              parsed.command === "init" &&
              !uuidPattern.test(explicitEnvironmentReference) &&
              error instanceof CliError &&
              error.code === "environment_not_found"
                ? initialEnvironmentFor(
                    admin,
                    initializedProject as Awaited<
                      ReturnType<typeof linkProject>
                    >,
                    explicitEnvironmentReference,
                  )
                : Promise.reject(error),
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
            `With --no-input, dotrelay ${parsed.command} needs --environment <environment-id-or-label>.`,
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
    const workflowOptions = {
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
    };
    // An explicit --environment is remembered for this worktree. Say so when
    // it replaces the saved one, or the next plain command surprises.
    const noteSwitchedEnvironment = (): void => {
      const previous = localContext?.environmentId;
      const next = contextToSave?.environmentId;
      if (parsed.json || !previous || !next || previous === next) return;
      // Commands that print their result to stdout would show the note
      // above their output, so only the publish-style ones carry it.
      if (!["push", "pull", "rollback", "init"].includes(parsed.command))
        return;
      (runtime.terminal?.output ?? process.stderr).write(
        `${railText(`Later commands in this repository use ${sanitizeCliLine(parsed.environment ?? "this environment")} too. To switch back, run dotrelay env use <label>.`, "faint")}\n`,
      );
    };
    // run, export, and list read the Environment like pull, without
    // writing anything; the other protected commands are the sync workflow.
    if (parsed.command === "run") {
      const exitCode = await runWithEnvironment(
        workflowOptions,
        parsed,
        runtime.spawn,
      );
      if (contextToSave) await writeWorktreeContext(contextPath, contextToSave);
      noteSwitchedEnvironment();
      return { value: { stdout: "" }, exitCode };
    }
    const workflowResult =
      parsed.command === "export"
        ? await exportEnvironment(workflowOptions, parsed)
        : parsed.command === "list"
          ? await listEnvironmentVariables(workflowOptions, parsed)
          : await runProtectedWorkflow(workflowOptions, parsed);
    // The worktree selection is persisted only after the workflow succeeds,
    // so a failed or declined operation leaves the saved Environment
    // untouched.
    if (contextToSave) await writeWorktreeContext(contextPath, contextToSave);
    noteSwitchedEnvironment();
    return { value: workflowResult };
  }
  throw new CliError(
    "invocation",
    `dotrelay ${parsed.command}${parsed.subcommand ? ` ${parsed.subcommand}` : ""} isn't available in this build.`,
    {},
    "command_unavailable",
  );
};

const profileNameFromArgs = (
  args: readonly string[],
): Readonly<{ profileName?: string }> => {
  try {
    const { profile } = parseArguments(args);
    return profile ? { profileName: profile } : {};
  } catch {
    return {};
  }
};

// Guided runs only happen where someone can answer: every stream is a
// terminal and nothing says this is automation.
const isInteractiveTerminal = (): boolean =>
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true &&
  process.stderr.isTTY === true &&
  process.env.CI === undefined;

const commandLabel = (args: readonly string[]): string => {
  try {
    const parsed = parseArguments(args);
    return parsed.subcommand
      ? `${parsed.command} ${parsed.subcommand}`
      : parsed.command;
  } catch {
    return "";
  }
};

// The origin of the Server Profile the command used, for plain headlines
// such as "You're signed out of api.dotrelay.dev". Best effort only.
const selectedOrigin = async (
  runtime: CliRuntime,
  args: readonly string[],
): Promise<string | undefined> => {
  try {
    const catalog = await createFileProfileCatalog(
      runtime.profilePath ?? profileCatalogPath(),
    ).read();
    const name = profileNameFromArgs(args).profileName ?? catalog.selected;
    return catalog.profiles.find((profile) => profile.name === name)?.origin;
  } catch {
    return undefined;
  }
};

// The exact command to run again, including what follows `--` for
// `dotrelay run`, quoted so it can be pasted into a POSIX shell.
const shellWord = (word: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;
const retryCommand = (args: readonly string[]): string =>
  ["dotrelay", ...args.map(shellWord)].join(" ");

/** A guided fix was offered and turned down; the run ends here. */
class GuidanceDeclined extends Error {
  readonly original: unknown;
  readonly next: string | undefined;
  constructor(original: unknown, next: string | undefined) {
    super("guidance declined");
    this.original = original;
    this.next = next;
  }
}

const chooseServer = async (runtime: CliRuntime): Promise<string> => {
  const hosted = new URL(setupOrigin).host;
  const choice = await selectOption(
    "Which server?",
    [
      { id: setupOrigin, label: hosted, detail: "hosted by DotRelay" },
      { id: "other", label: "Another server", detail: "type its address" },
    ],
    {
      ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
      ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
    },
  );
  if (choice !== "other") return choice;
  const { readTerminalLine } = await import("./terminal");
  const typed = (
    runtime.prompt
      ? await runtime.prompt("Server address")
      : await readTerminalLine(
          `${glyph("info")}  Server address`,
          runtime.terminal,
        )
  ).trim();
  if (typed.length === 0)
    throw new CliInvocationError("Enter the server's address to continue.");
  return typed;
};

type Executed = Awaited<ReturnType<typeof execute>> &
  Readonly<{ renderArgs: readonly string[] }>;

/**
 * Runs the command. When it stops on something the user can fix here
 * (signed out, not set up, no account key, a dropped connection), a guided
 * run says so in plain words, offers the fix, runs it on the same rail and
 * carries on. Each fix is offered at most once per run.
 */
const executeGuided = async (
  args: readonly string[],
  runtime: CliRuntime,
  guided: boolean,
): Promise<Executed> => {
  const output = runtime.terminal?.output ?? process.stderr;
  const offered = new Set<string>();
  let current = runtime;
  const own = ownArguments(args);
  const profileFlag = profileNameFromArgs(args).profileName;
  for (;;) {
    try {
      return { ...(await execute(args, current)), renderArgs: args };
    } catch (thrown) {
      if (!guided) throw thrown;
      const { code } = diagnosticForError(thrown);
      const guidance = guidanceFor(code, {
        command: commandLabel(args),
        origin: await selectedOrigin(runtime, args),
        guided: true,
      });
      const offer = guidance?.offer;
      if (!guidance || !offer || offered.has(code)) throw thrown;
      offered.add(code);
      output.write(
        `${markLine("warn", paint(guidance.title, "warn"))}\n${
          guidance.explain ? `${railText(guidance.explain)}\n` : ""
        }${bar()}\n`,
      );
      const accepted = await confirmAction(offer.question, {
        default: "yes",
        labels: [offer.accept, "Not now"],
        ...(runtime.confirm ? { confirm: runtime.confirm } : {}),
        ...(runtime.prompt ? { prompt: runtime.prompt } : {}),
        ...(runtime.terminal ? { terminal: runtime.terminal } : {}),
      });
      if (!accepted)
        throw new GuidanceDeclined(
          thrown,
          guidance.next ??
            (offer.fix.kind === "retry" ? retryCommand(args) : undefined),
        );
      const nested: CliRuntime = { ...runtime, nested: true };
      if (offer.fix.kind !== "retry") {
        const fixArgs = [
          ...(offer.fix.kind === "setup"
            ? ["setup", await chooseServer(runtime)]
            : offer.fix.args),
          ...(profileFlag && offer.fix.kind !== "setup"
            ? ["--profile", profileFlag]
            : []),
          ...(own.includes("--debug") ? ["--debug"] : []),
        ];
        const fixed = await execute(fixArgs, nested);
        if (!offer.resume) return { ...fixed, renderArgs: fixArgs };
        if (!("stdout" in fixed.value))
          output.write(
            renderSuccess(parseArguments(fixArgs), fixed.value, {
              closing: false,
            }),
          );
      }
      current = nested;
    }
  }
};

export const run = async (
  args: readonly string[],
  runtime: CliRuntime = {},
): Promise<CliRunResult> => {
  // Only the tokens before a bare -- are DotRelay's; the rest belong to
  // the command `dotrelay run` starts.
  const own = ownArguments(args);
  const guided =
    (runtime.guide ??
      (isInteractiveTerminal() &&
        runtime.terminal === undefined &&
        runtime.prompt === undefined &&
        runtime.confirm === undefined)) &&
    !own.includes("--json") &&
    !own.includes("--no-input");
  try {
    rejectForbiddenFlags(args);
    if (own.includes("--help") || own.includes("-h") || args.length === 0) {
      // Route --help to the selected command's help when a command is named,
      // so `dotrelay rollback --help` never answers with the everyday list.
      const label = helpLabelFor(helpTopicFor(own));
      const help = label ? renderCommandHelp(label) : renderHelp();
      return {
        exitCode: EXIT_CODES.success,
        stdout: `${help}\n`,
        stderr: "",
      };
    }
    if (own.includes("--version") || own.includes("-v"))
      return {
        exitCode: EXIT_CODES.success,
        stdout: `${version}\n`,
        stderr: "",
      };
    const result = await executeGuided(args, runtime, guided);
    const parsed = parseArguments(
      result.renderArgs,
      runtime.stdoutIsTerminal === undefined
        ? {}
        : { stdoutIsTerminal: runtime.stdoutIsTerminal },
    );
    return {
      exitCode: result.exitCode ?? EXIT_CODES.success,
      stdout:
        "stdout" in result.value
          ? String(result.value.stdout)
          : renderSuccess(parsed, result.value),
      stderr: "",
    };
  } catch (caught) {
    const declined = caught instanceof GuidanceDeclined ? caught : null;
    const thrown = declined ? declined.original : caught;
    const error = await withGitHubAppInstallHint(thrown, {
      store: createFileProfileCatalog(
        runtime.profilePath ?? profileCatalogPath(),
      ),
      ...profileNameFromArgs(args),
      ...(defaultOrigin ? { defaultOrigin } : {}),
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
      ...(runtime.networkPolicy
        ? { networkPolicy: runtime.networkPolicy }
        : {}),
    });
    const debug = own.includes("--debug");
    const diagnostic = diagnosticForError(error, { debug });
    // A declined offer already showed the headline; end with the command
    // to run later.
    if (declined)
      return {
        exitCode: diagnostic.exitCode,
        stdout: "",
        stderr: `${epilogueNext(declined.next)}\n`,
      };
    const guidance = guidanceFor(diagnostic.code, {
      command: commandLabel(args),
      origin: await selectedOrigin(runtime, args),
      noInput: own.includes("--no-input"),
    });
    const presentation = presentationForError(error, { debug });
    const parsedNext = presentation.fixes
      // A fix line may end its sentence with a dot; the command doesn't.
      .map((fix) => /^Run (dotrelay \S.*?)\.?$/.exec(fix)?.[1])
      .find((command) => command !== undefined);
    const next = guidance?.next ?? parsedNext;
    if (own.includes("--json"))
      return {
        exitCode: diagnostic.exitCode,
        stdout: "",
        stderr: json(next ? { ...diagnostic, next } : diagnostic),
      };
    // Saying no at a confirmation isn't a mistake to correct: end calmly
    // with what didn't happen, not a "Check the command" card.
    const declinedConfirmation = /^you didn't confirm, so (.+?)\.?$/su.exec(
      diagnostic.detail,
    );
    if (declinedConfirmation?.[1] && diagnostic.category === "invocation")
      return {
        exitCode: diagnostic.exitCode,
        stdout: "",
        stderr: `${paint(GLYPHS.end, "ghost")}  ${capitalize(declinedConfirmation[1])}\n`,
      };
    // "Check the command" says less than an invocation error's own first
    // sentence, so that sentence becomes the headline:
    // "dotrelay setup needs the server's address".
    const generic =
      guidance === null &&
      diagnostic.category === "invocation" &&
      presentation.title === categoryTitleFor("invocation");
    const firstSentence = generic
      ? /^(.+?[^.\s])\.(?:\s+(?=[A-Z<])|$)/su.exec(presentation.detail)
      : null;
    const headline = firstSentence?.[1] ?? null;
    const body =
      headline === null
        ? presentation.detail
        : presentation.detail.slice(firstSentence?.[0].length ?? 0).trim();
    // Someone at a terminal gets the plain explanation; scripts and
    // --no-input keep the precise detail with its flags and file names.
    const plain = guided && guidance?.explain !== undefined && !debug;
    return {
      exitCode: diagnostic.exitCode,
      stdout: "",
      stderr: `${errorCard({
        title: guidance?.title ?? headline ?? presentation.title,
        detail: plain ? (guidance?.explain ?? "") : body,
        fixes: plain
          ? []
          : presentation.fixes.filter(
              // The same command as `next`, maybe with an aside, is dropped;
              // a fix that offers another route ("or ...") stays.
              (fix) =>
                next === undefined ||
                (fix !== `Run ${next}` &&
                  fix !== `Run ${next}.` &&
                  !fix.startsWith(`Run ${next} (`)),
            ),
        next,
      })}\n`,
    };
  }
};

const epilogueNext = (next: string | undefined): string =>
  next
    ? `${paint(GLYPHS.end, "ghost")}  ${paint("next", "faint")}  ${bold(next)}`
    : paint(GLYPHS.end, "ghost");

const writeFully = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
  new Promise((resolve) => {
    stream.write(text, () => resolve());
  });

if (import.meta.main) {
  const result = await run(
    Bun.argv.slice(2),
    process.stdout.isTTY === undefined
      ? {}
      : { stdoutIsTerminal: process.stdout.isTTY },
  );
  if (result.stdout) await writeFully(process.stdout, result.stdout);
  if (result.exitCode === 0) {
    const clearDisplayed = consumeDisplayedRecoveryCode();
    if (clearDisplayed) await clearDisplayed().catch(() => {});
  }
  if (result.stderr) await writeFully(process.stderr, result.stderr);
  if (typeof process.stdin.setRawMode === "function")
    process.stdin.setRawMode(false);
  process.stdin.pause();
  // Exit only after both writes have been flushed so piped output is not
  // truncated.
  process.exit(result.exitCode);
}
