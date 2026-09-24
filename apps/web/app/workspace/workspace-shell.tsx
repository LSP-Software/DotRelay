"use client";

import {
  createBrowserProfilePinStore,
  passkeyPrfSupported,
} from "@dotrelay/client";
import {
  Archive,
  Braces,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  KeyRound,
  LockKeyhole,
  LogOut,
  Menu,
  MonitorSmartphone,
  RotateCcw,
  Users,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyableCommand } from "@/components/copyable-command";
import { CommandText, InlineCommand } from "@/components/inline-command";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type AccountKeyActor,
  type AccountKeyWrapperEntry,
  fetchAccountKeyWrappers,
} from "@/lib/account-keys";
import {
  addEncryptionPassword,
  addPasskeyPrf,
  commitPresentedRecoveryCode,
  discardPresentedRecoveryCode,
  type RecoveryCeremony,
  removeEncryptionPassword,
  removePasskeyPrf,
  rotateRecoveryCode,
  sendAccountKeyTransfer,
  setupAccountRecovery,
  unlockAccount,
  unlockMethods,
} from "@/lib/account-recovery";
import {
  type PendingEnrollment,
  provisionBrowserDevice as provisionBrowserDeviceFlow,
  repairStaleEpoch as repairStaleEpochFlow,
} from "@/lib/device-provisioning";
import {
  type EnvironmentContextIdentity,
  environmentContextIdentity,
  environmentContextKey,
  planContextSwitch,
} from "@/lib/environment-context";
import type { EnvironmentProtocolSession } from "@/lib/environment-protocol-session";
import {
  displayedSetupAction,
  isPrivilegedRole,
  nextSetupAction,
  type SetupAction,
} from "@/lib/environment-workflow";
import {
  acceptTeamInvitation,
  changeEnvironmentLifecycle,
  changeProjectLifecycle,
  changeTeamMemberRole,
  createTeamInvitation,
  fetchMyInvitations,
  fetchTeamMemberships,
  type MyInvitations,
  type ResolvedGitHubUser,
  removeTeamMember,
  resolveGitHubLogin,
  type TeamMembershipState,
} from "@/lib/team-administration";
import { cn } from "@/lib/utils";
import {
  emptyWorkspaceBoundary,
  enrolledDeviceRows,
  type MembershipRole,
  projectDisplayName,
  type ResourceLifecycle,
  resolveApiOrigin,
  resolveWorkspaceProfileId,
  type WorkspaceBoundary,
  type WorkspaceProfileId,
  type WorkspaceProject,
  workspaceProfileCatalog,
} from "@/lib/workspace-boundary";
import {
  parseWorkspaceLocation,
  resolveWorkspaceLocation,
  sameWorkspaceLocation,
  serializeWorkspaceLocation,
  type WorkspaceLocation,
  type WorkspaceMissingResource,
  type WorkspaceView,
} from "@/lib/workspace-location";
import {
  RecoveryArea,
  RecoveryCodeDialog,
  RemovePasskeyDialog,
  RemovePasswordDialog,
} from "@/lib/workspace-recovery-views";
import {
  createWorkspaceRefreshLoop,
  loadWorkspaceSession,
} from "@/lib/workspace-session";
import { EnvironmentEditor } from "./environment-editor";

type ProfileId = WorkspaceProfileId;
type ConnectionState = "loading" | "online" | "offline";

type SelectionRequest = Readonly<{
  readonly profileId?: ProfileId | undefined;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  readonly view: WorkspaceView;
}>;

type RetainedEditorContext = Readonly<{
  readonly identity: EnvironmentContextIdentity;
  readonly session: EnvironmentProtocolSession | null;
  readonly available: boolean;
  readonly setupAction: SetupAction | null;
  readonly setupCommand?: string | undefined;
  readonly setupMessage?: string | null;
}>;

type DraftState = Readonly<{
  readonly dirty: boolean;
  readonly changedVariableNames: readonly string[];
}>;

type PendingSwitch = Readonly<{
  readonly target: WorkspaceLocation;
  readonly rebinding: boolean;
  readonly leavingLabel: string;
  readonly targetLabel?: string | undefined;
  readonly details: readonly string[];
  // history.go delta that returns the browser to the entry the user left
  // when dismissing a prompt opened by Back/Forward.
  readonly restore?: number | undefined;
}>;

const environmentDisplayLabel = (
  environment: WorkspaceProject["environments"][number] | null | undefined,
  project: WorkspaceProject | null | undefined,
): string =>
  environment && project
    ? `${environment.label} · ${projectDisplayName(project)}`
    : (environment?.label ?? "an environment");

// The deployment decides which Server Profile this shell is bound to. Only
// the explicit development fixture keeps the URL-driven preview selector, so
// a live deployment can never be pointed at another backend from the browser.
const DEPLOYMENT_PROFILE_ID: WorkspaceProfileId = resolveWorkspaceProfileId();
const WORKSPACE_FIXTURE =
  process.env.NEXT_PUBLIC_DOTRELAY_WORKSPACE_FIXTURE === "1";

const roleDisclosure: Readonly<Record<MembershipRole, string>> = {
  OWNER: "Owners can manage team members, projects, and environments.",
  ADMIN:
    "Admins can invite and remove members and manage projects and environments. They cannot change owners or other admins.",
  MEMBER:
    "Members can view this team's projects, read shared values, and manage their own values.",
};

const roleLabel = (role: MembershipRole | undefined): string =>
  role === "OWNER" ? "Owner" : role === "ADMIN" ? "Admin" : "Member";

// Invitation and expiry timestamps are absolute, so a human-readable date is
// shown rather than a raw offset.
const formatDate = (iso: string | undefined): string => {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const missingResourceCopy: Readonly<
  Record<
    WorkspaceMissingResource["kind"],
    Readonly<{ title: string; description: string }>
  >
> = {
  team: {
    title: "That team is no longer available",
    description:
      "It may have been deleted, or you may have lost access. You're now viewing the first available team.",
  },
  project: {
    title: "That project is no longer available",
    description:
      "It may have been archived or deleted, or you may have lost access. Choose another project to continue.",
  },
  environment: {
    title: "That environment is no longer available",
    description:
      "It may have been deleted, or you may have lost access. You're now viewing the project's first available environment.",
  },
};

// The search strings of the history entries the shell committed itself, plus
// the position it believes it holds. Module-scoped so the bookkeeping
// survives a remount of the shell within the tab; a full page load starts
// fresh and re-anchors on the URL the shell hydrates.
const workspaceHistoryBookkeeping = {
  entries: [] as string[],
  index: 0,
};

// The entries the shell writes keep a null history.state: Next.js's App
// Router reloads the page for popstate entries it does not own (any custom
// state object triggers that), and re-asserts stale URLs for ones it does,
// so the shell must stay out of history.state entirely. Back/Forward then
// identifies its target by the entry's search string, matching the adjacent
// entries first; when a search string repeats on both sides of the current
// entry (a projects → team → projects round trip), the two sides denote the
// same location, so the visible state stays correct and the bookkeeping
// index re-syncs on the next move.
const urlForSearch = (search: string) =>
  search ? `${window.location.pathname}?${search}` : window.location.pathname;

// Rewrite the current entry in place so its URL keeps matching the visible
// state without adding a history entry.
const replaceHistoryEntry = (search: string) => {
  if (workspaceHistoryBookkeeping.entries.length === 0) {
    workspaceHistoryBookkeeping.entries = [search];
  }
  workspaceHistoryBookkeeping.entries[workspaceHistoryBookkeeping.index] =
    search;
  window.history.replaceState(null, "", urlForSearch(search));
};

const LifecycleDialog = ({
  resource,
  lifecycle,
  disabled,
  onConfirm,
}: {
  readonly resource: "Project" | "Environment";
  readonly lifecycle: ResourceLifecycle;
  readonly disabled: boolean;
  readonly onConfirm: () => void;
}) => {
  const isActive = lifecycle === "ACTIVE";
  const verb = isActive ? "archive" : "restore";

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            disabled={disabled}
            variant={isActive ? "destructive" : "outline"}
          />
        }
      >
        {isActive ? (
          <Archive aria-hidden="true" />
        ) : (
          <RotateCcw aria-hidden="true" />
        )}
        {isActive ? "Archive" : "Restore"} {resource.toLowerCase()}
      </DialogTrigger>
      <DialogContent role="alertdialog">
        <DialogHeader>
          <DialogTitle>
            {isActive ? "Archive" : "Restore"} {resource.toLowerCase()}?
          </DialogTitle>
          <DialogDescription>
            {isActive
              ? resource === "Environment"
                ? "Archiving hides this environment's variables but keeps its history. Restore it to access the variables again."
                : "Archiving frees this GitHub repository for another project to use."
              : resource === "Environment"
                ? "Restoring lets devices with the required keys access this environment again. It does not grant new permissions."
                : "You can restore this project only if no other active project uses this GitHub repository."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <DialogClose
            render={
              <Button
                onClick={onConfirm}
                variant={isActive ? "destructive" : "default"}
              />
            }
          >
            Confirm {verb}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const copyText = async (value: string) => {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    return;
  }
};

// The Argon2id worker source is fetched once per page load and handed to the
// client's KDF at call time through the documented global. Without it the
// client derives on the main thread, which blocks for seconds at the default
// cost, so the cheap fetch always happens; a failed fetch falls back to the
// main thread rather than breaking password unlock.
const installArgon2Worker = () => {
  const global = globalThis as {
    __DOTRELAY_ARGON2_WORKER_SOURCE__?: string;
  };
  if (typeof global.__DOTRELAY_ARGON2_WORKER_SOURCE__ === "string") return;
  void (async () => {
    try {
      const response = await fetch("/argon2-worker.js", {
        cache: "force-cache",
      });
      if (!response.ok) return;
      global.__DOTRELAY_ARGON2_WORKER_SOURCE__ = await response.text();
    } catch {
      // The main-thread fallback remains available.
    }
  })();
};

const NavLinks = ({
  onNavigate,
  onOpenProject,
  onSetView,
  selectedProjectId,
  teamProjects,
  view,
}: {
  readonly onNavigate?: () => void;
  readonly onOpenProject: (project: WorkspaceProject) => void;
  readonly onSetView: (view: WorkspaceView) => void;
  readonly selectedProjectId: string | null;
  readonly teamProjects: readonly WorkspaceProject[];
  readonly view: WorkspaceView;
}) => (
  <nav aria-label="Workspace navigation" className="grid gap-1">
    <button
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
        view === "projects" || view === "environment"
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground",
      )}
      onClick={() => {
        onSetView("projects");
        onNavigate?.();
      }}
      type="button"
    >
      <FolderGit2 aria-hidden="true" className="size-4" />
      Projects
    </button>
    {teamProjects.map((project) => (
      <button
        className={cn(
          "ml-4 truncate rounded-lg px-3 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          selectedProjectId === project.id && view === "environment"
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-muted-foreground",
        )}
        key={project.id}
        onClick={() => {
          onOpenProject(project);
          onNavigate?.();
        }}
        type="button"
      >
        {projectDisplayName(project)}
      </button>
    ))}
    <button
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        view === "team"
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground",
      )}
      onClick={() => {
        onSetView("team");
        onNavigate?.();
      }}
      type="button"
    >
      <Users aria-hidden="true" className="size-4" />
      Team
    </button>
    <button
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        view === "devices"
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground",
      )}
      onClick={() => {
        onSetView("devices");
        onNavigate?.();
      }}
      type="button"
    >
      <MonitorSmartphone aria-hidden="true" className="size-4" />
      Devices
    </button>
    <button
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        view === "recovery"
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground",
      )}
      onClick={() => {
        onSetView("recovery");
        onNavigate?.();
      }}
      type="button"
    >
      <KeyRound aria-hidden="true" className="size-4" />
      Recovery
    </button>
  </nav>
);

// After this long the initial workspace load is treated as stalled (a hung
// fetch, not a slow one) and the shell offers a concrete retry instead of an
// open-ended spinner. Healthy loads resolve in well under a second.
const LOADING_STALL_MS = 8_000;

export const WorkspaceShell = ({
  protocolSession,
}: Readonly<{
  readonly protocolSession?: EnvironmentProtocolSession;
}>) => {
  const [role, setRole] = useState<MembershipRole>("OWNER");
  const [profileId, setProfileId] = useState<ProfileId>(DEPLOYMENT_PROFILE_ID);
  const [boundary, setBoundary] = useState<WorkspaceBoundary>(() =>
    emptyWorkspaceBoundary(DEPLOYMENT_PROFILE_ID),
  );
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [verifiedAt, setVerifiedAt] = useState<number | null>(null);
  // While the boundary hasn't been verified, the shell shows a loading state.
  // If that load outlasts a generous threshold - a hung fetch, not a slow one -
  // it switches to a concrete "still connecting" state with a retry so the user
  // is never stranded on an open-ended spinner.
  const [loadingStalled, setLoadingStalled] = useState(false);
  const reconnectNowRef = useRef<(() => void) | null>(null);
  const boundaryJsonRef = useRef(
    JSON.stringify(emptyWorkspaceBoundary(DEPLOYMENT_PROFILE_ID)),
  );
  const [teamId, setTeamId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [view, setView] = useState<WorkspaceView>("projects");
  const [environmentLifecycle, setEnvironmentLifecycle] =
    useState<ResourceLifecycle>("ACTIVE");
  const [projectLifecycle, setProjectLifecycle] =
    useState<ResourceLifecycle>("ACTIVE");
  // The service's explanation when an archive/restore could not be persisted.
  // Keyed by the resource the user acted on so the failure stays visible next
  // to that resource's controls instead of reverting silently.
  const [lifecycleError, setLifecycleError] = useState<{
    readonly resource: "environment" | "project";
    readonly message: string;
  } | null>(null);
  const [invitationOpen, setInvitationOpen] = useState(false);
  // The invitation dialog is a two-step flow: resolve a GitHub login to its
  // stable subject, then create the invitation. The resolved identity is
  // retained so a failed create keeps everything the user already confirmed.
  const [inviteLogin, setInviteLogin] = useState("");
  const [inviteStep, setInviteStep] = useState<"form" | "confirmed">("form");
  const [inviteResolved, setInviteResolved] =
    useState<ResolvedGitHubUser | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // The Team's persisted membership record, fetched from the service so it
  // survives reloads and Team switches. Null while loading or unavailable.
  const [membershipState, setMembershipState] =
    useState<TeamMembershipState | null>(null);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipTick, setMembershipTick] = useState(0);
  // The in-flight role or removal mutation, one at a time, keyed by
  // Membership so the row's controls can stay busy while it runs.
  const [memberMutation, setMemberMutation] = useState<{
    readonly membershipId: string;
    readonly kind: "role" | "remove";
  } | null>(null);
  const [memberMutationError, setMemberMutationError] = useState<{
    readonly membershipId: string;
    readonly message: string;
  } | null>(null);
  const [myInvitations, setMyInvitations] = useState<MyInvitations | null>(
    null,
  );
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<
    string | null
  >(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sessionsByKey, setSessionsByKey] = useState<
    ReadonlyMap<string, EnvironmentProtocolSession>
  >(() => new Map());
  const [retainedEditors, setRetainedEditors] = useState<
    ReadonlyMap<string, RetainedEditorContext>
  >(() => new Map());
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(
    null,
  );
  const [contextStale, setContextStale] = useState(false);
  const [missingResource, setMissingResource] =
    useState<WorkspaceMissingResource | null>(null);
  const draftStateRef = useRef<Map<string, DraftState>>(new Map());
  const [deviceSetupMessage, setDeviceSetupMessage] = useState<string | null>(
    null,
  );
  const [deviceSetupInProgress, setDeviceSetupInProgress] = useState(false);
  // Inline rename of this browser's Device. The server stops auto-updating
  // the name once nameOverridden is true; a failed rename keeps the previous
  // label visible and shows the error beside the control.
  const [deviceRenameOpen, setDeviceRenameOpen] = useState(false);
  const [deviceRenameValue, setDeviceRenameValue] = useState("");
  const [deviceRenameBusy, setDeviceRenameBusy] = useState(false);
  const [deviceRenameError, setDeviceRenameError] = useState<string | null>(
    null,
  );
  // The trust decision this browser recorded for the boundary's origin and
  // server identity: "unknown" until the stored pin for the pair is checked,
  // never "trusted" from a different origin or identity.
  const [profileTrust, setProfileTrust] = useState<
    "unknown" | "trusted" | "untrusted"
  >("unknown");
  const [trustDialogOpen, setTrustDialogOpen] = useState(false);
  const [trustDialogBusy, setTrustDialogBusy] = useState(false);
  const [trustBlocked, setTrustBlocked] = useState<string | null>(null);
  // Approval gate for a Device replacement: replacing the Device discards the
  // keys this browser holds for the current Device, so it is proposed only
  // after the in-place key repairs have been ruled out.
  const [replacementDialogOpen, setReplacementDialogOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [browserCrypto, setBrowserCrypto] = useState(true);
  // In-browser Account Key recovery. The Account Master Key never reaches
  // persistent storage on a browser device: policy keeps it in memory only,
  // so an unlocked state lasts for this page session and the next visit
  // starts locked again (unlock via Recovery Code, Encryption Password,
  // passkey, or a transfer). A ref keeps the key bytes out of state: they
  // must not re-render or churn the session-load effect, which re-runs on
  // the generation counter instead.
  const accountMasterKeyRef = useRef<Uint8Array | null>(null);
  const [accountUnlocked, setAccountUnlocked] = useState(false);
  const [recoveryGeneration, setRecoveryGeneration] = useState(0);
  // The account's active Account Key Wrappers, listed by the service.
  const [recoveryWrappers, setRecoveryWrappers] = useState<
    readonly AccountKeyWrapperEntry[]
  >([]);
  // One in-flight recovery mutation at a time, so the area stays busy while
  // a wrapper, envelope, or transfer commit lands.
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  // The Recovery Code shown before it becomes the active recovery route.
  // The ceremony stays in this ref until the user confirms, so a retry
  // publishes the same key instead of minting another one.
  const recoveryCeremony = useRef<RecoveryCeremony | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [recoveryCodeNote, setRecoveryCodeNote] = useState<string | null>(null);
  const [unlockMethod, setUnlockMethod] = useState<
    "recovery-code" | "password" | "passkey-prf" | "transfer"
  >("recovery-code");
  const [unlockInput, setUnlockInput] = useState("");
  const [password, setPassword] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [addPasswordOpen, setAddPasswordOpen] = useState(false);
  const [transferIdInput, setTransferIdInput] = useState("");
  const [removePasswordDialogOpen, setRemovePasswordDialogOpen] =
    useState(false);
  const [removePasskeyDialogOpen, setRemovePasskeyDialogOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState<string | null>(null);
  // A transfer this browser offered to a peer Device, with the id and expiry
  // the receiver needs before the transfer lapses.
  const [sentTransfer, setSentTransfer] = useState<Readonly<{
    readonly transferId: string;
    readonly expiresAt: string;
    readonly recipientDeviceId: string;
  }> | null>(null);
  // Detected after mount. The server render has no WebAuthn surface, so
  // reading it during the first render would disagree with the browser and
  // hydrate the Add passkey control as permanently unavailable.
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  useEffect(() => {
    setPasskeyAvailable(passkeyPrfSupported());
  }, []);
  // Pending enrollment identity (keys + operation id) retained across retries
  // so a storage failure after the Server Profile created the Device cannot
  // be retried as a fresh, duplicate enrollment.
  const pendingEnrollmentRef = useRef<Map<string, PendingEnrollment>>(
    new Map(),
  );
  // Server Profile pins for which durable browser enrollment holds in this
  // page load: enrollment completed with verified persistent storage, or the
  // stored Device bundle was loaded from durable storage. A memory-only
  // fallback is never added, so it is never claimed as enrolled.
  const durableBrowserDeviceRef = useRef<Set<string>>(new Set());
  // history.go delta of the prompt opened by Back/Forward, or null. A ref so
  // a popstate that discards an open prompt invalidates its restore before
  // the dialog's close handler can run; a stale prompt must not pull the
  // browser back to the entry the user just left.
  const promptRestoreRef = useRef<number | null>(null);
  // The protected store of verified trust decisions; one pin per
  // (origin, server identity) pair, checked and written by name.
  const pinStore = useMemo(() => createBrowserProfilePinStore(), []);

  const protectedPreview = preview === "protected";
  const noCryptoPreview = preview === "no-crypto";

  const displayBoundary = useMemo(() => {
    const cryptoAvailable =
      !noCryptoPreview &&
      browserCrypto &&
      (protectedPreview || boundary.crypto.available);
    // A browser that unlocked the Account Master Key in this session reads
    // the project's current epoch key from the boundary's Account Key
    // Envelope (see the session loader below), which the server's
    // per-device grant tally does not count. The editor treats that
    // combination as ready instead of stranding the user on "pending
    // grants".
    const envelopeReady =
      accountUnlocked &&
      !protectedPreview &&
      !boundary.grantsReady &&
      boundary.accountKeyEnvelope !== undefined &&
      boundary.environment.projectId !== undefined;
    return {
      ...boundary,
      device: protectedPreview
        ? { active: true, label: "Active device" }
        : boundary.device,
      grantsReady:
        protectedPreview || boundary.grantsReady || envelopeReady
          ? true
          : boundary.grantsReady,
      epochCurrent:
        protectedPreview || boundary.epochCurrent || envelopeReady
          ? true
          : boundary.epochCurrent,
      rotationRequired: protectedPreview ? false : boundary.rotationRequired,
      crypto: cryptoAvailable
        ? { available: true }
        : {
            available: false,
            problemCode: "crypto_provider_unavailable" as const,
          },
    };
  }, [
    boundary,
    browserCrypto,
    noCryptoPreview,
    protectedPreview,
    accountUnlocked,
  ]);
  // Trust is a browser-side decision: a pin this browser recorded for the
  // exact origin and server identity the boundary verified, or the explicit
  // development preview. It is never implied by the deployment alone.
  const profileTrusted = protectedPreview || profileTrust === "trusted";

  const teams = displayBoundary.catalog.teams;
  const selectedTeam =
    teams.find((team) => team.id === teamId) ?? teams[0] ?? null;
  const teamProjects = displayBoundary.catalog.projects.filter(
    (project) => project.teamId === selectedTeam?.id,
  );
  const teamsWithProjects = new Set(
    displayBoundary.catalog.projects.map((project) => project.teamId),
  );
  const selectedProject =
    teamProjects.find((project) => project.id === projectId) ?? null;
  const selectedEnvironment =
    selectedProject?.environments.find(
      (environment) => environment.id === environmentId,
    ) ??
    selectedProject?.environments[0] ??
    null;
  const teamRoleFor = (teamId: string | null): MembershipRole =>
    displayBoundary.source === "fixture" || preview === "admin"
      ? role
      : (teams.find((team) => team.id === teamId)?.role ?? "MEMBER");
  const effectiveRole = teamRoleFor(selectedTeam?.id ?? null);
  const canAdminister = isPrivilegedRole(effectiveRole);
  const cliCommand = `dotrelay setup ${displayBoundary.profile.origin}`;
  const currentIdentity = environmentContextIdentity({
    profileId,
    serverProfileId: boundary.profile.serverProfileId,
    teamId,
    projectId,
    environmentId,
  });
  const currentKey = environmentContextKey(currentIdentity);
  const selectedSession = sessionsByKey.get(currentKey) ?? null;
  const currentPinKey = boundary.profile.serverProfileId
    ? `${boundary.profile.origin}\u0000${boundary.profile.serverProfileId}`
    : null;
  // Stable identity while the verified pair is unchanged, so the lookup
  // below re-runs only when the origin or server identity changes, not on
  // every render.
  const serverPin = useMemo(
    () =>
      boundary.profile.serverProfileId
        ? {
            origin: boundary.profile.origin,
            serverProfileId: boundary.profile.serverProfileId,
          }
        : null,
    [boundary.profile.origin, boundary.profile.serverProfileId],
  );
  const thisBrowserEnrolled =
    protectedPreview ||
    Boolean(protocolSession) ||
    (currentPinKey !== null &&
      durableBrowserDeviceRef.current.has(currentPinKey));
  const enrolledDevices = enrolledDeviceRows(displayBoundary, {
    thisBrowserEnrolled,
  });

  // The membership and invitation surfaces are reached straight from the
  // browser at the Server Profile's API origin. A deployment that never
  // declares that origin has no live Team record to show, so the fetches are
  // skipped rather than pointed at an unrelated server.
  const apiOrigin = resolveApiOrigin();
  const browserDeviceId =
    displayBoundary.device.active && !protectedPreview
      ? displayBoundary.device.id
      : undefined;
  const sessionActive = displayBoundary.session.active;

  // Recover the trust decision this browser recorded for the pair the
  // boundary just verified. The lookup keys on the pair, so a pin recorded
  // for another origin or server identity is never read. The state resets
  // to "unknown" the moment the pair changes, so a changed origin or server
  // identity is never shown trusted on the strength of a decision recorded
  // for a different pair while the lookup for the new pair is in flight.
  useEffect(() => {
    setProfileTrust("unknown");
    if (currentPinKey === null || serverPin === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const trusted = await pinStore.has(serverPin);
        if (!cancelled) setProfileTrust(trusted ? "trusted" : "untrusted");
      } catch {
        if (!cancelled) setProfileTrust("untrusted");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPinKey, pinStore, serverPin]);

  // Record the trust decision after the user has seen the exact origin and
  // server identity. A decision that cannot be kept durably is not claimed:
  // it would vanish on the next reload, which is the in-memory trust this
  // confirmation exists to replace.
  const confirmTrust = async () => {
    if (serverPin === null) return;
    setTrustDialogBusy(true);
    setTrustBlocked(null);
    try {
      if (!pinStore.durable) {
        setTrustBlocked(
          "This browser can't save the trust decision durably, so we haven't trusted this server. Allow site storage, then try again.",
        );
        return;
      }
      await pinStore.set(serverPin);
      setProfileTrust("trusted");
      setTrustDialogOpen(false);
    } catch {
      setTrustBlocked(
        "We couldn't save the trust decision in this browser. Allow site storage, then try again.",
      );
    } finally {
      setTrustDialogBusy(false);
    }
  };

  // Keep the selected Team's persisted membership record current: refetch on
  // Team or session change, on reconnecting, and after a mutation (tick).
  // biome-ignore lint/correctness/useExhaustiveDependencies: membershipTick and displayBoundary.connection are refetch triggers (post-mutation and reconnect) whose values are intentionally not read inside the effect
  useEffect(() => {
    const selectedTeamId = selectedTeam?.id;
    if (!apiOrigin || !selectedTeamId || !sessionActive) {
      setMembershipState(null);
      setMembershipError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setMembershipError(null);
      const result = await fetchTeamMemberships(apiOrigin, selectedTeamId);
      if (cancelled) return;
      if (result.ok) setMembershipState(result.data);
      else {
        setMembershipState(null);
        setMembershipError(result.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    apiOrigin,
    selectedTeam?.id,
    sessionActive,
    membershipTick,
    displayBoundary.connection,
  ]);

  // Keep the invitations addressed to the signed-in User current, so an
  // invitee who has not yet joined a Team still sees the invitation they hold.
  // biome-ignore lint/correctness/useExhaustiveDependencies: membershipTick and displayBoundary.connection are refetch triggers whose values are intentionally not read inside the effect
  useEffect(() => {
    if (!apiOrigin || !sessionActive) {
      setMyInvitations(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await fetchMyInvitations(apiOrigin);
      if (cancelled) return;
      setMyInvitations(result.ok ? result.data : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, sessionActive, membershipTick, displayBoundary.connection]);

  const refreshTeamAdministration = () => {
    setMembershipTick((tick) => tick + 1);
  };

  // The account-key routes act for the signed-in User's active Device, so
  // recovery state is derivable only when both exist.
  const recoveryActor: AccountKeyActor | null =
    apiOrigin && boundary.device.active && boundary.device.id
      ? { origin: apiOrigin, deviceId: boundary.device.id }
      : null;
  const recoveryActorKey = recoveryActor?.deviceId ?? null;

  // The shared inputs for every recovery mutation: the acting account, the
  // current boundary and listed wrappers, and the in-memory key vault. The
  // orchestration itself (lib/account-recovery.ts) reports back through
  // this feedback bundle and the mutation callback that bumps the
  // recovery generation.
  const recoveryInputs = {
    actor: recoveryActor,
    boundary,
    wrappers: recoveryWrappers,
    accountMasterKey: {
      read: () => accountMasterKeyRef.current,
      write: (key: Uint8Array) => {
        accountMasterKeyRef.current = key;
      },
      clear: () => {
        accountMasterKeyRef.current = null;
      },
    },
    passkeyAvailable,
  };
  const recoveryFeedback = {
    setBusy: setRecoveryBusy,
    setMessage: setRecoveryMessage,
    setError: setRecoveryError,
    setCode: (code: string | null, note: string | null) => {
      setRecoveryCode(code);
      setRecoveryCodeNote(note);
    },
    clearInputs: () => {
      setUnlockInput("");
      setPassword("");
      setTransferIdInput("");
    },
    setAccountUnlocked,
  };
  const onRecoveryMutated = () =>
    setRecoveryGeneration((generation) => generation + 1);

  // Keep the account's active wrappers listed by the service current: on
  // reconnect, after each recovery mutation (generation), and whenever the
  // area is opened so a long-idle tab doesn't act on a stale list.
  // A refresh triggered by a recovery generation bump must not clear the
  // alert the recovery handler just set (for example, a failed unlock);
  // reconnect and view-driven refreshes keep clearing stale alerts.
  const lastRecoveryGenerationRef = useRef(recoveryGeneration);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recoveryActor is derived from the depended-on keys (deviceId, api origin, device active) and is rebuilt each render
  useEffect(() => {
    const generationTriggered =
      recoveryGeneration !== lastRecoveryGenerationRef.current;
    lastRecoveryGenerationRef.current = recoveryGeneration;
    if (
      connection !== "online" ||
      recoveryActorKey === null ||
      !boundary.session.active
    ) {
      setRecoveryWrappers([]);
      return;
    }
    const actor = recoveryActor as AccountKeyActor;
    let cancelled = false;
    void (async () => {
      try {
        const wrappers = await fetchAccountKeyWrappers(actor);
        if (cancelled) return;
        setRecoveryWrappers(wrappers);
        if (!generationTriggered) setRecoveryError(null);
      } catch {
        if (cancelled) return;
        setRecoveryError(
          "We couldn't load this account's recovery options. Retry, or check the connection.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    connection,
    recoveryActorKey,
    boundary.session.active,
    recoveryGeneration,
    view,
  ]);

  // The periodic boundary refresh also establishes the project's Account Key
  // Envelope after an in-session unlock or rotation, so it re-runs on
  // recovery generation changes too.

  // Sign out the account session. The session cookie is scoped to the API
  // origin (see apps/api/src/auth.ts), so the request goes there with
  // credentials, mirroring the sign-in button. The workspace's local state
  // (device keys, trust decisions) is left intact, exactly as it would be
  // if the tab were closed, so the next sign-in restores the same browser
  // without re-enrolling.
  const signOut = async () => {
    const origin = resolveApiOrigin() ?? displayBoundary.profile.origin;
    try {
      const response = await fetch(`${origin}/api/auth/sign-out`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      // The API is unreachable or rejected the request; the page that
      // follows offers sign-in either way.
    } finally {
      window.location.assign("/sign-in");
    }
  };

  const resetInvitationDialog = () => {
    setInviteLogin("");
    setInviteStep("form");
    setInviteResolved(null);
    setInviteBusy(false);
    setInviteError(null);
  };

  const openInvitationDialog = () => {
    resetInvitationDialog();
    setInvitationOpen(true);
  };

  // Resolve a familiar GitHub login to its stable subject on the acting
  // User's behalf. A failure keeps the dialog open on the form the user was
  // filling in, with an explanation of what to fix.
  const resolveInvitation = async () => {
    const login = inviteLogin.trim();
    if (!login || !apiOrigin || inviteBusy) return;
    setInviteBusy(true);
    setInviteError(null);
    const result = await resolveGitHubLogin(apiOrigin, login, browserDeviceId);
    setInviteBusy(false);
    if (result.ok) {
      setInviteResolved(result.data);
      setInviteStep("confirmed");
    } else {
      setInviteError(result.message);
    }
  };

  // Create the invitation only after the login has resolved. "Invitation
  // created" is never shown until the service confirms it, and a failure
  // keeps the resolved identity so the user can retry without re-resolving.
  const createInvitation = async () => {
    const resolved = inviteResolved;
    const selectedTeamId = selectedTeam?.id;
    if (!apiOrigin || !resolved || !selectedTeamId || inviteBusy) return;
    setInviteBusy(true);
    setInviteError(null);
    const result = await createTeamInvitation(
      apiOrigin,
      selectedTeamId,
      resolved.githubUserId,
      browserDeviceId,
    );
    setInviteBusy(false);
    if (result.ok) {
      setInvitationOpen(false);
      resetInvitationDialog();
      refreshTeamAdministration();
    } else {
      setInviteError(result.message);
    }
  };

  // Accepting an invitation creates the User's pending Membership; no Device
  // is required, since the member has not finished key provisioning yet.
  const acceptInvitation = async (invitationId: string) => {
    if (!apiOrigin || acceptingInvitationId) return;
    setAcceptingInvitationId(invitationId);
    setAcceptError(null);
    const result = await acceptTeamInvitation(apiOrigin, invitationId);
    setAcceptingInvitationId(null);
    if (result.ok) {
      refreshTeamAdministration();
    } else {
      setAcceptError(result.message);
    }
  };
  // Changes the Member's role in the Team. The server withholds the owner
  // and admin rows from admins and enforces the last-owner guard, so the
  // row's controls mirror those bounds and a refusal stays visible on the
  // row the user acted on.
  const changeMemberRole = async (
    membershipId: string,
    role: MembershipRole,
  ) => {
    const selectedTeamId = selectedTeam?.id;
    if (!apiOrigin || !selectedTeamId || memberMutation) return;
    setMemberMutation({ membershipId, kind: "role" });
    setMemberMutationError(null);
    const result = await changeTeamMemberRole(
      apiOrigin,
      selectedTeamId,
      membershipId,
      role,
      browserDeviceId,
    );
    setMemberMutation(null);
    if (result.ok) {
      refreshTeamAdministration();
    } else {
      setMemberMutationError({ membershipId, message: result.message });
    }
  };

  // Removes the Member from the Team. A failure leaves the Membership in
  // place and shows the service's explanation on the row.
  const removeMember = async (membershipId: string) => {
    const selectedTeamId = selectedTeam?.id;
    if (!apiOrigin || !selectedTeamId || memberMutation) return;
    setMemberMutation({ membershipId, kind: "remove" });
    setMemberMutationError(null);
    const result = await removeTeamMember(
      apiOrigin,
      selectedTeamId,
      membershipId,
      browserDeviceId,
    );
    setMemberMutation(null);
    if (result.ok) {
      refreshTeamAdministration();
    } else {
      setMemberMutationError({ membershipId, message: result.message });
    }
  };

  // Archives or restores the selected Environment. The server persists the
  // change and reports the resulting lifecycle, so the state only flips when
  // the service confirms it; a refusal keeps the prior state and surfaces the
  // explanation instead of reverting silently.
  const persistEnvironmentLifecycle = async (action: "archive" | "restore") => {
    const target = selectedEnvironment?.id;
    // Self-hosted deployments may never declare an API origin at build time, so
    // fall back to the Server Profile origin the boundary already verified (the
    // same origin device bootstrap and key recovery use) instead of the
    // build-inlined value alone.
    const origin = apiOrigin ?? boundary.profile.origin;
    if (!origin || !target) return;
    setLifecycleError(null);
    const result = await changeEnvironmentLifecycle(
      origin,
      target,
      action,
      browserDeviceId,
    );
    if (result.ok) {
      setEnvironmentLifecycle(
        result.data.lifecycle === "archived" ? "ARCHIVED" : "ACTIVE",
      );
      // In a live deployment re-derive the boundary so the catalog (epoch,
      // device readiness) reflects the persisted change. The development
      // fixture is static, so only the confirmed reply updates it.
      if (!WORKSPACE_FIXTURE) reconnectNowRef.current?.();
    } else {
      setLifecycleError({ resource: "environment", message: result.message });
    }
  };

  // Archives or restores the selected Project, persisting through the service.
  const persistProjectLifecycle = async (action: "archive" | "restore") => {
    const target = selectedProject?.id;
    // Same self-hosted fallback as the environment handler and the device
    // bootstrap/recovery paths: use the verified profile origin when no
    // build-inlined API origin exists.
    const origin = apiOrigin ?? boundary.profile.origin;
    if (!origin || !target) return;
    setLifecycleError(null);
    const result = await changeProjectLifecycle(
      origin,
      target,
      action,
      browserDeviceId,
    );
    if (result.ok) {
      setProjectLifecycle(
        result.data.lifecycle === "archived" ? "ARCHIVED" : "ACTIVE",
      );
      if (!WORKSPACE_FIXTURE) reconnectNowRef.current?.();
    } else {
      setLifecycleError({ resource: "project", message: result.message });
    }
  };

  const unlockAccountHandler = (
    method: Parameters<typeof unlockAccount>[1],
    secret: string,
  ) =>
    void unlockAccount(
      recoveryInputs,
      method,
      secret,
      recoveryFeedback,
      onRecoveryMutated,
    );

  const setupAccountRecoveryHandler = () =>
    setupAccountRecovery(
      recoveryInputs,
      recoveryFeedback,
      onRecoveryMutated,
      recoveryCeremony,
    );

  const rotateRecoveryCodeHandler = () =>
    rotateRecoveryCode(
      recoveryInputs,
      recoveryFeedback,
      onRecoveryMutated,
      recoveryCeremony,
    );

  const confirmRecoveryCodeHandler = () =>
    commitPresentedRecoveryCode(
      recoveryInputs,
      recoveryFeedback,
      onRecoveryMutated,
      recoveryCeremony,
    );

  const dismissRecoveryCodeHandler = () =>
    discardPresentedRecoveryCode(recoveryCeremony, recoveryFeedback);

  const addEncryptionPasswordHandler = () =>
    addEncryptionPassword(
      recoveryInputs,
      addPassword,
      recoveryFeedback,
      onRecoveryMutated,
      () => {
        setAddPassword("");
        setAddPasswordOpen(false);
      },
    );

  const removeEncryptionPasswordHandler = () =>
    removeEncryptionPassword(
      recoveryInputs,
      recoveryFeedback,
      onRecoveryMutated,
      () => setRemovePasswordDialogOpen(false),
    );

  const addPasskeyHandler = () =>
    addPasskeyPrf(recoveryInputs, recoveryFeedback, onRecoveryMutated);

  const removePasskeyHandler = () =>
    removePasskeyPrf(recoveryInputs, recoveryFeedback, onRecoveryMutated, () =>
      setRemovePasskeyDialogOpen(false),
    );

  const sendAccountKeyTransferHandler = () =>
    sendAccountKeyTransfer(
      recoveryInputs,
      transferTarget,
      recoveryFeedback,
      onRecoveryMutated,
      (staged) => {
        setSentTransfer(staged);
        setTransferTarget(null);
      },
    );

  // The unlock methods, in display order.
  const unlockMethodOffers = unlockMethods(recoveryWrappers, passkeyAvailable);

  const setupAction = nextSetupAction({
    sessionActive: displayBoundary.session.active,
    profileTrusted,
    cryptoAvailable: displayBoundary.crypto.available,
    deviceActive: displayBoundary.device.active,
    grantsReady: displayBoundary.grantsReady,
    resourceActive:
      projectLifecycle === "ACTIVE" && environmentLifecycle === "ACTIVE",
    epochCurrent: displayBoundary.epochCurrent,
    rotationRequired: displayBoundary.rotationRequired,
  });
  const localDeviceBlockers =
    displayBoundary.device.active &&
    !protectedPreview &&
    !protocolSession &&
    !selectedSession;
  const protectedWorkflowAvailable =
    setupAction === null && !localDeviceBlockers;
  const cliSetupCommand =
    setupAction?.id === "crypto-unavailable" ||
    setupAction?.id === "enroll-device"
      ? cliCommand
      : undefined;
  const editorSetupAction = displayedSetupAction(setupAction, {
    localDeviceBlockers,
    inProgress: deviceSetupInProgress,
  });

  const removeSessionByKey = useCallback((key: string) => {
    setSessionsByKey((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);
  const selectedEditorContext = (): RetainedEditorContext => ({
    identity: currentIdentity,
    session: selectedSession,
    available: protectedWorkflowAvailable,
    setupAction: editorSetupAction,
    setupCommand: cliSetupCommand,
    setupMessage: deviceSetupMessage,
  });

  // Commit a location to app state and to the URL. A push records a new
  // history entry for user-initiated navigation; anything else (hydration,
  // catalog reconciliation, browser Back/Forward) replaces the current
  // entry so the URL keeps normalizing to the visible state.
  const applySelection = (
    location: Readonly<
      WorkspaceLocation & {
        readonly missing?: WorkspaceMissingResource | null;
      }
    >,
    options: Readonly<{
      readonly push: boolean;
      readonly discard?: boolean;
    }>,
  ) => {
    if (
      sameWorkspaceLocation(location, {
        profileId,
        teamId,
        projectId,
        environmentId,
        view,
      })
    ) {
      // Keep the missing-resource notice an earlier commit reported: the
      // re-resolved location no longer names the dropped resource, so
      // `location.missing` is null here even though the page still shows
      // the fallback for a resource the user asked for.
      setMissingResource(location.missing ?? missingResource);
      // The location is unchanged, but resource state can still drift under
      // it: a reload of a shared link reaches this branch after the catalog
      // loads, so lifecycle is re-derived from the catalog instead of
      // keeping the initial defaults.
      const project = displayBoundary.catalog.projects.find(
        (candidate) => candidate.id === location.projectId,
      );
      const environment = project?.environments.find(
        (candidate) => candidate.id === location.environmentId,
      );
      setProjectLifecycle(project?.lifecycle ?? "ACTIVE");
      setEnvironmentLifecycle(environment?.lifecycle ?? "ACTIVE");
      // The URL entry can still carry stale params (a history entry written
      // before the catalog dropped a resource); rewrite it so the entry
      // matches the visible state.
      if (typeof window === "undefined") return;
      const search = serializeWorkspaceLocation(
        location,
        new URLSearchParams(window.location.search),
      );
      if (window.location.search === (search ? `?${search}` : "")) return;
      replaceHistoryEntry(search);
      return;
    }
    const rebinding = location.profileId !== profileId;
    const contextChanged =
      !rebinding &&
      (location.teamId !== teamId ||
        location.projectId !== projectId ||
        location.environmentId !== environmentId);
    const discard = options.discard ?? false;
    if (rebinding) {
      setRetainedEditors(new Map());
      setSessionsByKey(new Map());
      draftStateRef.current.clear();
      pendingEnrollmentRef.current.clear();
      durableBrowserDeviceRef.current.clear();
      setContextStale(true);
    } else if (contextChanged) {
      if (currentIdentity.environmentId) {
        setRetainedEditors((prev) => {
          const next = new Map(prev);
          if (discard) next.delete(currentKey);
          else next.set(currentKey, selectedEditorContext());
          return next;
        });
        if (discard) draftStateRef.current.delete(currentKey);
      }
      if (discard) removeSessionByKey(currentKey);
      removeSessionByKey(
        environmentContextKey(
          environmentContextIdentity({
            ...currentIdentity,
            teamId: location.teamId,
            projectId: location.projectId,
            environmentId: location.environmentId,
          }),
        ),
      );
      setContextStale(true);
    }
    // View-only commits keep the live session and editor state: Back/Forward
    // and sidebar view switches must not reload or reset the Environment the
    // user is working in.
    setPendingSwitch(null);
    promptRestoreRef.current = null;
    setMissingResource(location.missing ?? null);
    if (rebinding) {
      resetWorkspaceContext();
      setProfileId(location.profileId);
      const placeholder = emptyWorkspaceBoundary(location.profileId);
      setBoundary(placeholder);
      boundaryJsonRef.current = JSON.stringify(placeholder);
      setVerifiedAt(null);
      setConnection("loading");
      setLoadingStalled(false);
    }
    setTeamId(location.teamId);
    setProjectId(location.projectId);
    setEnvironmentId(location.environmentId);
    setView(location.view);
    const project = displayBoundary.catalog.projects.find(
      (candidate) => candidate.id === location.projectId,
    );
    const environment = project?.environments.find(
      (candidate) => candidate.id === location.environmentId,
    );
    setProjectLifecycle(project?.lifecycle ?? "ACTIVE");
    setEnvironmentLifecycle(environment?.lifecycle ?? "ACTIVE");
    if (typeof window === "undefined") return;
    const search = serializeWorkspaceLocation(
      location,
      new URLSearchParams(window.location.search),
    );
    // Raw history calls create the entry synchronously. Router-queued pushes
    // can be demoted to a replace when a follow-up URL write lands in the
    // same cycle (a profile rebind reloads the boundary and re-normalizes
    // the URL), which would swallow the entry and break Back/Forward.
    // Next's patched pushState/replaceState mirror the URL into its router
    // state, so the two stay in step.
    if (options.push) {
      const entries = workspaceHistoryBookkeeping.entries.slice(
        0,
        workspaceHistoryBookkeeping.index + 1,
      );
      entries.push(search);
      workspaceHistoryBookkeeping.entries = entries;
      workspaceHistoryBookkeeping.index += 1;
      window.history.pushState(null, "", urlForSearch(search));
    } else {
      replaceHistoryEntry(search);
    }
  };

  const applySelectionRef = useRef(applySelection);
  applySelectionRef.current = applySelection;

  const affectedEnvironmentLabels = (): string[] => {
    const labels: string[] = [];
    const seen = new Set<string>();
    const identities = [
      currentIdentity,
      ...[...retainedEditors.values()].map((entry) => entry.identity),
    ];
    for (const identity of identities) {
      if (identity.profileId !== profileId || !identity.environmentId) continue;
      if (seen.has(identity.environmentId)) continue;
      if (
        draftStateRef.current.get(environmentContextKey(identity))?.dirty !==
        true
      )
        continue;
      seen.add(identity.environmentId);
      const project = displayBoundary.catalog.projects.find(
        (candidate) => candidate.id === identity.projectId,
      );
      const environment = project?.environments.find(
        (candidate) => candidate.id === identity.environmentId,
      );
      labels.push(environmentDisplayLabel(environment, project));
    }
    return labels;
  };

  const requestSelection = (request: SelectionRequest) => {
    if (pendingSwitch) return;
    const target: WorkspaceLocation = {
      profileId: request.profileId ?? profileId,
      teamId: request.teamId,
      projectId: request.projectId,
      environmentId: request.environmentId,
      view: request.view,
    };
    const next = environmentContextIdentity({
      ...currentIdentity,
      profileId: target.profileId,
      teamId: target.teamId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    });
    const dirtyDraft = draftStateRef.current.get(currentKey)?.dirty === true;
    const anyDraftDirty =
      dirtyDraft ||
      [...draftStateRef.current.values()].some((state) => state.dirty);
    const decision = planContextSwitch({
      current: currentIdentity,
      next,
      dirtyDraft,
    });
    const promptSwitch = (rebinding: boolean) => {
      // A prompt opened by user navigation has no entry to restore to.
      promptRestoreRef.current = null;
      setPendingSwitch({
        target,
        rebinding,
        leavingLabel: rebinding
          ? workspaceProfileCatalog[profileId].name
          : selectedEnvironment
            ? environmentDisplayLabel(selectedEnvironment, selectedProject)
            : (selectedTeam?.name ?? "this team"),
        targetLabel:
          rebinding && request.profileId
            ? workspaceProfileCatalog[request.profileId].name
            : undefined,
        details: rebinding
          ? affectedEnvironmentLabels()
          : (draftStateRef.current.get(currentKey)?.changedVariableNames ?? []),
      });
    };
    if (decision.type === "rebind") {
      if (anyDraftDirty) promptSwitch(true);
      else applySelection(target, { push: true });
      return;
    }
    if (decision.type === "prompt") {
      promptSwitch(false);
      return;
    }
    // "noop" (same context, possibly a new view) and "switch" (no dirty
    // draft) both commit directly; drafts are kept for the later return.
    applySelection(target, { push: true });
  };

  const openProject = (project: WorkspaceProject) => {
    requestSelection({
      teamId: project.teamId,
      projectId: project.id,
      environmentId: project.environments[0]?.id ?? null,
      view: "environment",
    });
  };

  const openWorkspaceView = (nextView: WorkspaceView) => {
    requestSelection({ teamId, projectId, environmentId, view: nextView });
  };

  // Hydrate the location the URL names. Profile and view are validated up
  // front; team/project/environment ids are validated against the catalog by
  // the reconciliation effect once the boundary loads. A live deployment is
  // bound to its own Server Profile, so the URL's profile parameter only
  // takes effect in the development fixture.
  useEffect(() => {
    setBrowserCrypto(
      typeof globalThis.crypto?.subtle?.importKey === "function",
    );
    const params = new URLSearchParams(window.location.search);
    // The preview parameter is a development-fixture affordance. A live
    // deployment must never honor it: asserting device readiness, role, or
    // crypto state that the verified boundary does not support would make
    // the UI lie about the workspace it is showing.
    const nextPreview = WORKSPACE_FIXTURE ? params.get("preview") : null;
    setPreview(nextPreview);
    const parsed = parseWorkspaceLocation(params);
    const initialProfileId = WORKSPACE_FIXTURE
      ? parsed.profileId
      : DEPLOYMENT_PROFILE_ID;
    if (initialProfileId !== DEPLOYMENT_PROFILE_ID) {
      setProfileId(initialProfileId);
      const placeholder = emptyWorkspaceBoundary(initialProfileId);
      setBoundary(placeholder);
      boundaryJsonRef.current = JSON.stringify(placeholder);
    }
    const initialView: WorkspaceView =
      parsed.view ??
      (parsed.projectId || nextPreview === "protected"
        ? "environment"
        : "projects");
    setTeamId(parsed.teamId);
    setProjectId(parsed.projectId);
    setEnvironmentId(parsed.environmentId);
    setView(initialView);
    const search = serializeWorkspaceLocation(
      {
        profileId: initialProfileId,
        teamId: parsed.teamId,
        projectId: parsed.projectId,
        environmentId: parsed.environmentId,
        view: initialView,
      },
      params,
    );
    // A full load starts with empty bookkeeping and anchors on this URL. A
    // remount within the tab re-anchors on the entry the tab already wrote,
    // so Back/Forward prompts opened after the remount still restore the
    // entry the user left.
    const anchored = workspaceHistoryBookkeeping.entries.indexOf(search);
    if (anchored === -1) {
      workspaceHistoryBookkeeping.entries = [search];
      workspaceHistoryBookkeeping.index = 0;
    } else {
      workspaceHistoryBookkeeping.index = anchored;
    }
    replaceHistoryEntry(search);
  }, []);

  useEffect(() => {
    const guardUnload = (event: BeforeUnloadEvent) => {
      for (const state of draftStateRef.current.values()) {
        if (!state.dirty) continue;
        event.preventDefault();
        event.returnValue = "";
        return "";
      }
    };
    window.addEventListener("beforeunload", guardUnload);
    return () => window.removeEventListener("beforeunload", guardUnload);
  }, []);

  useEffect(() => {
    installArgon2Worker();
  }, []);

  const viewFallback = useCallback(
    (hasProject: boolean): WorkspaceView =>
      hasProject || preview === "protected" ? "environment" : "projects",
    [preview],
  );

  // Reconcile the app's location against the loaded catalog: default to the
  // first Team, drop resources the catalog no longer knows (with a recovery
  // notice), and open the first Project for the protected preview when no
  // Project is open. The location comes from app state, never from the URL:
  // the URL can still lag a user-initiated navigation, and re-reading it
  // here would undo the navigation that just committed. Skipped until a
  // catalog is verified so a fresh offline load never treats the empty
  // placeholder as the real workspace.
  useEffect(() => {
    // A prompt is waiting on the user's decision; never reconcile
    // behind its back or the prompt gets committed away.
    if (pendingSwitch) return;
    if (teams.length === 0 && connection !== "online") return;
    const target = resolveWorkspaceLocation(
      { profileId, teamId, projectId, environmentId, view },
      displayBoundary.catalog,
      viewFallback,
    );
    if (
      sameWorkspaceLocation(target, {
        profileId,
        teamId,
        projectId,
        environmentId,
        view,
      })
    ) {
      if (preview !== "protected") {
        // Commit through applySelection so the same-location path re-derives
        // resource lifecycle from the catalog and normalizes the URL entry;
        // a reload of a shared link lands here.
        applySelectionRef.current(target, { push: false });
        return;
      }
      if (!target.teamId) return;
      // A Project is already open, so the user's Team/Project/Environment
      // choice stands; never re-point it at the first Project.
      if (target.projectId) return;
      const firstProject = displayBoundary.catalog.projects.find(
        (project) => project.teamId === target.teamId,
      );
      if (!firstProject) return;
      applySelectionRef.current(
        {
          ...target,
          projectId: firstProject.id,
          environmentId: firstProject.environments[0]?.id ?? null,
          view: "environment",
        },
        { push: false },
      );
      return;
    }
    applySelectionRef.current(target, { push: false });
  }, [
    displayBoundary.catalog,
    teams,
    connection,
    preview,
    viewFallback,
    pendingSwitch,
    profileId,
    teamId,
    projectId,
    environmentId,
    view,
  ]);

  // Browser Back/Forward: the URL of the history entry is the source of
  // truth, so reconcile app state to it. Same-Profile moves keep any dirty
  // drafts (they stay retained for the forward trip); a Profile rebind with
  // dirty drafts prompts, and dismissing the prompt restores the entry the
  // user left.
  const handlePopState = () => {
    // A Back/Forward that leaves the workspace page navigates away from it;
    // only entries under /workspace are owned by this shell.
    if (window.location.pathname !== "/workspace") return;
    const fromIndex = workspaceHistoryBookkeeping.index;
    const entries = workspaceHistoryBookkeeping.entries;
    // The stored entries carry no leading "?" while location.search does.
    // Back/Forward lands on the entry next to the one left, so match the
    // adjacent entries first; a search string that repeats on both sides
    // names the same location, so either side keeps the visible state
    // correct. Anything else is an entry the app never wrote, which can
    // only sit below the first entry the shell committed.
    const search = window.location.search.replace(/^\?/, "");
    let toIndex: number;
    if (fromIndex > 0 && entries[fromIndex - 1] === search) {
      toIndex = fromIndex - 1;
    } else if (
      fromIndex < entries.length - 1 &&
      entries[fromIndex + 1] === search
    ) {
      toIndex = fromIndex + 1;
    } else {
      const found = entries.indexOf(search);
      toIndex = found === -1 ? 0 : found;
    }
    workspaceHistoryBookkeeping.index = toIndex;
    const restore = fromIndex - toIndex;
    if (pendingSwitch) {
      // The browser moved again; the open prompt describes the entry left
      // behind, so drop it (and any restore it would have run).
      setPendingSwitch(null);
      promptRestoreRef.current = null;
    }
    const parsed = parseWorkspaceLocation(
      new URLSearchParams(window.location.search),
    );
    // A live deployment's history entries all belong to its own Server
    // Profile; the entry's profile parameter is authoritative only in the
    // development fixture.
    const entry = WORKSPACE_FIXTURE
      ? parsed
      : { ...parsed, profileId: DEPLOYMENT_PROFILE_ID };
    const target =
      teams.length > 0 || connection === "online"
        ? resolveWorkspaceLocation(entry, displayBoundary.catalog, viewFallback)
        : {
            profileId: entry.profileId,
            teamId: entry.teamId,
            projectId: entry.projectId,
            environmentId: entry.environmentId,
            view: entry.view ?? viewFallback(entry.projectId !== null),
            missing: null,
          };
    if (
      sameWorkspaceLocation(target, {
        profileId,
        teamId,
        projectId,
        environmentId,
        view,
      })
    ) {
      // Same location, but the entry's URL can still need normalizing.
      applySelection(target, { push: false });
      return;
    }
    const rebinding = target.profileId !== profileId;
    if (rebinding) {
      const anyDraftDirty = [...draftStateRef.current.values()].some(
        (state) => state.dirty,
      );
      if (anyDraftDirty) {
        promptRestoreRef.current = restore;
        setPendingSwitch({
          target,
          rebinding: true,
          restore,
          leavingLabel: workspaceProfileCatalog[profileId].name,
          targetLabel: workspaceProfileCatalog[target.profileId].name,
          details: affectedEnvironmentLabels(),
        });
        return;
      }
      applySelection(target, { push: false, discard: true });
      return;
    }
    applySelection(target, { push: false });
  };
  const handlePopStateRef = useRef(handlePopState);
  handlePopStateRef.current = handlePopState;
  useEffect(() => {
    const listener = () => handlePopStateRef.current();
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);

  const commitBoundary = (next: WorkspaceBoundary) => {
    boundaryJsonRef.current = JSON.stringify(next);
    setBoundary(next);
    setVerifiedAt(Date.now());
    setConnection("online");
  };

  const requestRetry = () => reconnectNowRef.current?.();

  const renameCurrentDevice = useCallback(async () => {
    const name = deviceRenameValue.trim();
    if (!apiOrigin || !browserDeviceId || name.length === 0) return;
    setDeviceRenameBusy(true);
    setDeviceRenameError(null);
    try {
      const response = await fetch(`${apiOrigin}/api/v1/devices/self`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-DotRelay-Device-Id": browserDeviceId,
        },
        body: JSON.stringify({ displayName: name }),
      });
      if (!response.ok) {
        setDeviceRenameError("Could not rename this Device");
        return;
      }
      const body = (await response.json()) as {
        name?: unknown;
        clientKind?: unknown;
        osName?: unknown;
        clientSummary?: unknown;
      };
      const next = {
        ...boundary,
        device: {
          ...boundary.device,
          ...(typeof body.name === "string" && body.name
            ? { name: body.name }
            : {}),
          ...(typeof body.clientKind === "string"
            ? { clientKind: body.clientKind }
            : {}),
          ...(typeof body.osName === "string" ? { osName: body.osName } : {}),
          ...(typeof body.clientSummary === "string"
            ? { clientSummary: body.clientSummary }
            : {}),
        },
      };
      boundaryJsonRef.current = JSON.stringify(next);
      setBoundary(next);
      setDeviceRenameOpen(false);
      setDeviceRenameValue("");
    } catch {
      setDeviceRenameError("Could not rename this Device");
    } finally {
      setDeviceRenameBusy(false);
    }
  }, [apiOrigin, browserDeviceId, boundary, deviceRenameValue]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: accountUnlocked mirrors accountMasterKeyRef, which the effect reads; recoveryGeneration is re-run state
  useEffect(() => {
    const loop = createWorkspaceRefreshLoop({
      profileId,
      teamId,
      projectId,
      environmentId,
      boundary,
      recoveryWrappers,
      accountUnlocked,
      apiOrigin,
      boundaryJson: {
        get: () => boundaryJsonRef.current,
        set: (value) => {
          boundaryJsonRef.current = value;
        },
      },
      accountMasterKey: {
        get: () => accountMasterKeyRef.current,
      },
      reconnectNowRef,
      setConnection,
      setVerifiedAt,
      setBoundary,
      removeSessionByKey,
    });
    return () => loop.dispose();
  }, [
    profileId,
    teamId,
    projectId,
    environmentId,
    removeSessionByKey,
    recoveryGeneration,
  ]);

  // Bound the open-ended loading state: a healthy load of a profile resolves
  // in well under a second, so if it is still unverified after the stall
  // threshold the fetch has hung. A profile change rebinds the shell and
  // restarts the episode; key the timer on it so a slow-but-healthy load of
  // the new profile is not reported as stalled by the previous episode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: profileId re-keys the stall timer on profile change and is intentionally not read inside the effect
  useEffect(() => {
    if (connection !== "loading" || verifiedAt !== null) {
      setLoadingStalled(false);
      return;
    }
    const timer = setTimeout(() => setLoadingStalled(true), LOADING_STALL_MS);
    return () => clearTimeout(timer);
  }, [connection, verifiedAt, profileId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recoveryActor and the verification helpers are derived from the depended-on boundary keys and read fresh, so each boundary commit already re-runs the loader with current values
  useEffect(() => {
    let cancelled = false;
    loadWorkspaceSession(
      {
        boundary,
        profileId,
        teamId,
        projectId,
        environmentId,
        recoveryWrappers,
        recoveryActor,
        accountMasterKey: {
          get: () => accountMasterKeyRef.current,
        },
        durableBrowserDevice: durableBrowserDeviceRef.current,
        removeSessionByKey,
        setSessionsByKey,
        setContextStale,
      },
      cancelled,
    );
    return () => {
      cancelled = true;
    };
    // The Account Master Key lives in a ref: an in-session unlock or
    // rotation (recoveryGeneration) re-derives the project's shared value
    // secret through the envelope, so the loader runs whenever that state
    // changes.
  }, [
    boundary,
    profileId,
    teamId,
    projectId,
    environmentId,
    removeSessionByKey,
    accountUnlocked,
    recoveryGeneration,
  ]);

  const provisioningContext = {
    apiOrigin: resolveApiOrigin() ?? boundary.profile.origin,
    profileId,
    boundary,
    selectedProjectId: selectedProject?.id ?? null,
    selectedTeamId: selectedTeam?.id ?? null,
    selectedTeamName: selectedTeam?.name ?? null,
    selectedEnvironmentId: selectedEnvironment?.id ?? null,
    environmentId,
    pendingEnrollment: {
      get: (key: string) => pendingEnrollmentRef.current.get(key),
      set: (key: string, value: PendingEnrollment) =>
        pendingEnrollmentRef.current.set(key, value),
      delete: (key: string) => pendingEnrollmentRef.current.delete(key),
    },
    durableBrowserDevice: {
      add: (key: string) => durableBrowserDeviceRef.current.add(key),
    },
    onMessage: setDeviceSetupMessage,
    onInProgress: setDeviceSetupInProgress,
    onCommit: commitBoundary,
    onOffline: () => setConnection("offline"),
  };

  const provisionBrowserDevice = () =>
    provisionBrowserDeviceFlow(provisioningContext);

  const repairStaleEpoch = () =>
    repairStaleEpochFlow({
      apiOrigin: resolveApiOrigin() ?? boundary.profile.origin,
      profileId,
      boundary,
      selectedEnvironmentId: selectedEnvironment?.id ?? null,
      environmentId,
      selectedTeamName: selectedTeam?.name ?? null,
      onMessage: setDeviceSetupMessage,
      onInProgress: setDeviceSetupInProgress,
      onCommit: commitBoundary,
      onOffline: () => setConnection("offline"),
      onReplacementNeeded: () => setReplacementDialogOpen(true),
    });

  const handleSetupAction = () => {
    if (!editorSetupAction) return;
    if (editorSetupAction.id === "stale-epoch") {
      void repairStaleEpoch();
      return;
    }
    if (editorSetupAction.id === "trust-profile") {
      // Trusting is a deliberate decision: the dialog names the exact origin
      // and stable server identity before the user confirms.
      setTrustBlocked(null);
      setTrustDialogOpen(true);
      return;
    }
    if (editorSetupAction.id === "enroll-device") {
      void provisionBrowserDevice();
      return;
    }
    if (editorSetupAction.id === "pending-grants") {
      // The fix lives in the Recovery area: unlock the account key there
      // (recovery code, password, or a transfer from another Device) and
      // the session reads the project's key from its Account Key Envelope.
      setDeviceSetupMessage(null);
      setView("recovery");
      return;
    }
    if (editorSetupAction.id === "crypto-unavailable") {
      void copyText(cliCommand).then(() =>
        setDeviceSetupMessage("Copied the setup command."),
      );
      return;
    }
    if (editorSetupAction.id === "archived") {
      setEnvironmentLifecycle("ACTIVE");
      return;
    }
    if (editorSetupAction.id === "rotation") {
      requestRetry();
    }
  };

  const resetWorkspaceContext = () => {
    // The in-memory Account Master Key is bound to the User on the profile
    // being left; a rebind must never carry it to another server.
    accountMasterKeyRef.current = null;
    setAccountUnlocked(false);
    setRecoveryWrappers([]);
    setRecoveryCode(null);
    setRecoveryCodeNote(null);
    setRecoveryMessage(null);
    setRecoveryError(null);
    setUnlockInput("");
    setPassword("");
    setAddPassword("");
    setAddPasswordOpen(false);
    setTransferIdInput("");
    setTransferTarget(null);
    setSentTransfer(null);
    setRemovePasswordDialogOpen(false);
    setEnvironmentLifecycle("ACTIVE");
    setProjectLifecycle("ACTIVE");
    setLifecycleError(null);
    setInvitationOpen(false);
    resetInvitationDialog();
    setMembershipState(null);
    setMembershipError(null);
    setAcceptError(null);
    setProfileTrust("unknown");
    setTrustDialogOpen(false);
    setTrustBlocked(null);
    setReplacementDialogOpen(false);
    setProjectId(null);
    setEnvironmentId(null);
    setView("projects");
  };

  const requestProfileChange = (nextProfileId: ProfileId) => {
    if (nextProfileId === profileId) return;
    requestSelection({
      profileId: nextProfileId,
      teamId: null,
      projectId: null,
      environmentId: null,
      view: "projects",
    });
  };

  const handleTeamChange = (nextTeamId: string) => {
    requestSelection({
      teamId: nextTeamId,
      projectId: null,
      environmentId: null,
      view: "projects",
    });
  };

  const closeMobile = () => setMobileOpen(false);

  const restoreHistoryEntry = (delta: number) => {
    if (delta !== 0 && typeof window !== "undefined") {
      window.history.go(delta);
    }
  };
  const switchRebinding = pendingSwitch?.rebinding === true;
  const envVisible =
    view === "environment" &&
    selectedProject !== null &&
    selectedEnvironment !== null;
  const selectedEntry: RetainedEditorContext | null =
    currentIdentity.environmentId ? selectedEditorContext() : null;
  const editorEntries: readonly RetainedEditorContext[] = selectedEntry
    ? [
        selectedEntry,
        ...[...retainedEditors.values()].filter(
          (entry) => environmentContextKey(entry.identity) !== currentKey,
        ),
      ]
    : [...retainedEditors.values()];

  return (
    <div className="min-h-screen bg-background">
      <a
        className="fixed left-4 top-4 z-[100] -translate-y-24 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:translate-y-0"
        href="#workspace-content"
      >
        Skip to workspace
      </a>

      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r bg-sidebar lg:flex lg:flex-col">
        <div className="flex h-16 items-center gap-3 border-b px-5">
          <span className="grid size-8 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <Braces aria-hidden="true" className="size-4" />
          </span>
          <span className="font-heading font-semibold">DotRelay</span>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
          {teams.length > 0 ? (
            <div>
              <Label
                className="px-3 text-xs text-muted-foreground"
                htmlFor="team-switcher"
              >
                Team
              </Label>
              <select
                aria-label="Team"
                className="mt-1 h-9 w-full rounded-lg border border-input bg-input/30 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                id="team-switcher"
                onChange={(event) => handleTeamChange(event.target.value)}
                value={selectedTeam?.id ?? ""}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {teamsWithProjects.has(team.id)
                      ? team.name
                      : `${team.name} (no projects)`}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <NavLinks
            onOpenProject={openProject}
            onSetView={openWorkspaceView}
            selectedProjectId={selectedProject?.id ?? null}
            teamProjects={teamProjects}
            view={view}
          />
        </div>
        <div className="mt-auto border-t p-4">
          {displayBoundary.session.active ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label={`Account menu: ${displayBoundary.session.displayName ?? "Account"}`}
                    className="h-auto w-full justify-start gap-3 rounded-lg px-2 py-1.5"
                    variant="ghost"
                  />
                }
              >
                <Avatar size="sm">
                  {displayBoundary.session.image && (
                    <AvatarImage
                      alt=""
                      referrerPolicy="no-referrer"
                      src={displayBoundary.session.image}
                    />
                  )}
                  <AvatarFallback>
                    {(displayBoundary.session.displayName ?? "DR")
                      .slice(0, 2)
                      .toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-medium">
                    {displayBoundary.session.displayName ?? "Signed out"}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Signed in
                  </span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  data-testid="account-sign-out"
                  onClick={() => void signOut()}
                >
                  <LogOut aria-hidden="true" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="flex items-center gap-3">
              <Avatar size="sm">
                <AvatarFallback>
                  {(displayBoundary.session.displayName ?? "DR")
                    .slice(0, 2)
                    .toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {displayBoundary.session.displayName ?? "Signed out"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Sign in required
                </p>
              </div>
            </div>
          )}
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-xl">
          <div className="flex min-h-16 items-center gap-3 px-4 sm:px-6">
            <Sheet onOpenChange={setMobileOpen} open={mobileOpen}>
              <SheetTrigger
                render={
                  <Button
                    aria-label="Open navigation"
                    className="lg:hidden"
                    size="icon"
                    variant="outline"
                  />
                }
              >
                <Menu aria-hidden="true" />
              </SheetTrigger>
              <SheetContent className="bg-sidebar" side="left">
                <SheetHeader className="border-b">
                  <SheetTitle className="flex items-center gap-2">
                    <Braces className="size-4 text-primary" /> DotRelay
                  </SheetTitle>
                  <SheetDescription>Workspace navigation</SheetDescription>
                </SheetHeader>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
                  {teams.length > 0 ? (
                    <>
                      <Label htmlFor="team-switcher-mobile">Team</Label>
                      <select
                        aria-label="Team"
                        className="h-9 w-full rounded-lg border border-input bg-input/30 px-3 text-sm"
                        id="team-switcher-mobile"
                        onChange={(event) => {
                          handleTeamChange(event.target.value);
                          closeMobile();
                        }}
                        value={selectedTeam?.id ?? ""}
                      >
                        {teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {teamsWithProjects.has(team.id)
                              ? team.name
                              : `${team.name} (no projects)`}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : null}
                  <NavLinks
                    onNavigate={closeMobile}
                    onOpenProject={openProject}
                    onSetView={openWorkspaceView}
                    selectedProjectId={selectedProject?.id ?? null}
                    teamProjects={teamProjects}
                    view={view}
                  />
                </div>
                {displayBoundary.session.active ? (
                  <div className="mt-auto border-t p-3">
                    <Button
                      data-testid="mobile-sign-out"
                      onClick={() => void signOut()}
                      className="w-full justify-start gap-2"
                      variant="ghost"
                    >
                      <LogOut aria-hidden="true" />
                      Sign out
                    </Button>
                  </div>
                ) : null}
              </SheetContent>
            </Sheet>

            {selectedTeam ? (
              <div className="hidden min-w-0 items-center gap-2 text-sm sm:flex">
                <span className="truncate">{selectedTeam.name}</span>
                {selectedProject ? (
                  <>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3 text-muted-foreground"
                    />
                    <span className="truncate">
                      {projectDisplayName(selectedProject)}
                    </span>
                  </>
                ) : null}
                {selectedEnvironment && view === "environment" ? (
                  <>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3 text-muted-foreground"
                    />
                    <span>{selectedEnvironment.label}</span>
                  </>
                ) : null}
              </div>
            ) : null}

            {/* The header offers a server switch only in the development
                fixture, where it previews hosted and self-hosted deployments.
                A live deployment is bound to the backend it is served from,
                so the browser offers no choice of server. */}
            {WORKSPACE_FIXTURE ? (
              <div className="ml-auto flex items-center gap-2">
                <Label className="sr-only" htmlFor="server-profile">
                  Server
                </Label>
                <select
                  aria-label="Server"
                  className="h-9 max-w-44 rounded-lg border border-input bg-input/30 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  id="server-profile"
                  onChange={(event) =>
                    requestProfileChange(event.target.value as ProfileId)
                  }
                  value={profileId}
                >
                  {(Object.keys(workspaceProfileCatalog) as ProfileId[]).map(
                    (id) => (
                      <option key={id} value={id}>
                        {workspaceProfileCatalog[id].name}
                      </option>
                    ),
                  )}
                </select>
              </div>
            ) : null}
          </div>
        </header>

        <main
          className="mx-auto max-w-[1500px] p-4 sm:p-6"
          id="workspace-content"
          tabIndex={-1}
        >
          {connection === "loading" ? (
            <section
              aria-live="polite"
              className="py-24 text-center text-sm text-muted-foreground"
              data-testid="workspace-loading"
            >
              {loadingStalled ? (
                <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-6">
                  <p className="text-base font-medium text-foreground">
                    Still connecting to the server
                  </p>
                  <p className="text-sm text-muted-foreground">
                    This is taking longer than usual. You can try again, or
                    check that the DotRelay server is reachable.
                  </p>
                  <Button data-testid="workspace-retry" onClick={requestRetry}>
                    Try again
                  </Button>
                </div>
              ) : (
                "Loading workspace…"
              )}
            </section>
          ) : connection === "offline" && verifiedAt === null ? (
            <section
              className="mx-auto max-w-xl py-24"
              data-testid="workspace-offline"
            >
              <Alert className="border-destructive/40">
                <WifiOff aria-hidden="true" />
                <AlertTitle>Couldn't reach your server</AlertTitle>
                <AlertDescription>
                  We couldn't verify your account, teams, or projects, so we
                  haven't shown any of them. We'll keep trying to connect. You
                  can also try again now.
                </AlertDescription>
              </Alert>
              <div className="mt-4">
                <Button data-testid="workspace-retry" onClick={requestRetry}>
                  Try again
                </Button>
              </div>
            </section>
          ) : (
            <>
              {connection === "offline" && verifiedAt !== null ? (
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Alert
                    className="flex-1 border-amber-300/30 bg-amber-300/5"
                    data-testid="workspace-connection-error"
                  >
                    <WifiOff aria-hidden="true" className="text-amber-300" />
                    <AlertTitle>
                      Connection lost. This data may be out of date.
                    </AlertTitle>
                    <AlertDescription>
                      Last verified at{" "}
                      {new Date(verifiedAt).toLocaleTimeString()}. We'll keep
                      trying to reconnect. You can also try again now.
                    </AlertDescription>
                  </Alert>
                  <Button
                    className="shrink-0"
                    data-testid="workspace-retry"
                    onClick={requestRetry}
                    variant="outline"
                  >
                    Try again
                  </Button>
                </div>
              ) : null}
              {missingResource && sessionActive ? (
                <Alert
                  className="mb-4 border-amber-300/30 bg-amber-300/5"
                  data-testid="workspace-missing-resource"
                >
                  <AlertTitle>
                    {missingResourceCopy[missingResource.kind].title}
                  </AlertTitle>
                  <AlertDescription>
                    {missingResource.kind === "environment" &&
                    selectedProject &&
                    selectedProject.environments.length === 0
                      ? "The project has no environments. Run this in the project's repository to create the first one: dotrelay init."
                      : missingResourceCopy[missingResource.kind].description}
                  </AlertDescription>
                </Alert>
              ) : null}
              {apiOrigin &&
              sessionActive &&
              myInvitations &&
              (myInvitations.invitations.length > 0 ||
                myInvitations.pendingMemberships.length > 0) ? (
                <Card
                  className="mb-4 border-primary/30"
                  data-testid="my-invitations-card"
                >
                  <CardHeader>
                    <CardTitle>Invitations for you</CardTitle>
                    <CardDescription>
                      Teams that invited you by your GitHub account. Accepting
                      keeps you pending until you receive the encryption keys
                      your device needs.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {myInvitations.invitations.map((invitation) => (
                      <div
                        key={invitation.invitationId}
                        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div>
                          <div className="font-medium">
                            {invitation.teamName}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            Invitation to join {invitation.teamName} · expires{" "}
                            {formatDate(invitation.expiresAt)}
                          </div>
                        </div>
                        <Button
                          disabled={
                            acceptingInvitationId === invitation.invitationId
                          }
                          onClick={() =>
                            acceptInvitation(invitation.invitationId)
                          }
                        >
                          {acceptingInvitationId === invitation.invitationId
                            ? "Accepting…"
                            : "Accept invitation"}
                        </Button>
                      </div>
                    ))}
                    {myInvitations.pendingMemberships.map((pending) => (
                      <div
                        key={pending.teamId}
                        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div>
                          <div className="font-medium">{pending.teamName}</div>
                          <div className="text-sm text-muted-foreground">
                            You accepted this team's invitation.
                          </div>
                        </div>
                        <Badge
                          className="border-amber-300/25 text-amber-200"
                          variant="outline"
                        >
                          Waiting for encryption keys
                        </Badge>
                      </div>
                    ))}
                    {acceptError ? (
                      <Alert className="border-destructive/30 bg-destructive/10">
                        <AlertTitle>Couldn't accept that invitation</AlertTitle>
                        <AlertDescription>{acceptError}</AlertDescription>
                      </Alert>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}
              {view === "projects" ? (
                <section>
                  {!sessionActive ? (
                    <section
                      className="mx-auto max-w-xl py-24"
                      data-testid="sign-in-required"
                    >
                      <Card>
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            <LockKeyhole
                              className="size-5 text-amber-300"
                              aria-hidden="true"
                            />
                            <h1 className="font-heading text-3xl font-semibold tracking-tight">
                              Sign in
                            </h1>
                          </CardTitle>
                          <CardDescription>
                            GitHub only identifies you. Sign in to see your
                            teams, projects, and environments.
                          </CardDescription>
                        </CardHeader>
                        <CardFooter>
                          <a
                            className="inline-flex h-8 items-center rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground"
                            href="/sign-in"
                          >
                            Sign in
                          </a>
                        </CardFooter>
                      </Card>
                    </section>
                  ) : teams.length === 0 ? (
                    <div className="mb-6" data-testid="no-teams-empty">
                      <h1 className="font-heading text-3xl font-semibold tracking-tight">
                        No teams yet
                      </h1>
                      <p className="mt-2 max-w-2xl text-muted-foreground">
                        A Team is where the projects that share your environment
                        variables live. Run this in a GitHub repository to
                        create your first Team, Project, and Environment:{" "}
                        <InlineCommand value="dotrelay init" />.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="mb-6">
                        <p className="text-sm text-muted-foreground">Team</p>
                        <h1 className="font-heading text-3xl font-semibold tracking-tight">
                          {selectedTeam?.name ?? "Choose a team"}
                        </h1>
                        <p className="mt-2 max-w-2xl text-muted-foreground">
                          Open a project to manage its environment variables and
                          secrets. Switch teams using the team menu.
                        </p>
                      </div>
                      {setupAction &&
                      (setupAction.id === "sign-in" ||
                        setupAction.id === "trust-profile" ||
                        setupAction.id === "crypto-unavailable") ? (
                        <div className="mb-6">
                          <EnvironmentEditor
                            available={false}
                            contextIdentity={currentIdentity}
                            onSetupAction={handleSetupAction}
                            role={teamRoleFor(currentIdentity.teamId)}
                            setupAction={setupAction}
                            setupBusy={deviceSetupInProgress}
                            setupCommand={cliSetupCommand}
                            setupMessage={deviceSetupMessage}
                          />
                        </div>
                      ) : null}
                      {teamProjects.length === 0 ? (
                        <Card>
                          <CardHeader>
                            <CardTitle>No projects yet</CardTitle>
                            <CardDescription>
                              Run this in your GitHub repository to create a
                              project: <InlineCommand value="dotrelay init" />.
                            </CardDescription>
                          </CardHeader>
                        </Card>
                      ) : (
                        <div className="grid gap-4 md:grid-cols-2">
                          {teamProjects.map((project) => (
                            <button
                              className="rounded-xl border bg-card p-5 text-left ring-1 ring-foreground/10 transition-colors hover:bg-muted/40"
                              key={project.id}
                              onClick={() => openProject(project)}
                              type="button"
                            >
                              <p className="text-xs text-muted-foreground">
                                Project
                              </p>
                              <h2 className="mt-1 font-heading text-xl font-medium">
                                {projectDisplayName(project)}
                              </h2>
                              <p className="mt-2 text-sm text-muted-foreground">
                                {project.environments
                                  .map((environment) => environment.label)
                                  .join(", ") || "No environments yet"}
                              </p>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </section>
              ) : null}

              {view === "environment" &&
              selectedProject &&
              selectedEnvironment ? (
                <section>
                  <div className="mb-5 flex flex-col items-start gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">
                        {selectedTeam?.name}
                      </p>
                      <h1 className="font-heading text-3xl font-semibold tracking-tight">
                        {projectDisplayName(selectedProject)}
                      </h1>
                    </div>
                    <LifecycleDialog
                      disabled={!canAdminister}
                      lifecycle={environmentLifecycle}
                      onConfirm={() =>
                        void persistEnvironmentLifecycle(
                          environmentLifecycle === "ACTIVE"
                            ? "archive"
                            : "restore",
                        )
                      }
                      resource="Environment"
                    />
                    {lifecycleError?.resource === "environment" ? (
                      <p
                        role="alert"
                        className="text-xs font-medium text-destructive"
                      >
                        {lifecycleError.message}
                      </p>
                    ) : null}
                  </div>
                  <Tabs
                    className="mb-6"
                    onValueChange={(nextId) => {
                      if (typeof nextId !== "string") return;
                      requestSelection({
                        teamId: selectedTeam?.id ?? null,
                        projectId: selectedProject.id,
                        environmentId: nextId,
                        view: "environment",
                      });
                    }}
                    value={selectedEnvironment.id}
                  >
                    <TabsList aria-label="Environments">
                      {selectedProject.environments.map((environment) => (
                        <TabsTrigger
                          key={environment.id}
                          value={environment.id}
                        >
                          {environment.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </section>
              ) : null}

              {view === "environment" &&
              selectedProject &&
              !selectedEnvironment ? (
                <section>
                  <div className="mb-5">
                    <p className="text-sm text-muted-foreground">
                      {selectedTeam?.name}
                    </p>
                    <h1 className="font-heading text-3xl font-semibold tracking-tight">
                      {projectDisplayName(selectedProject)}
                    </h1>
                  </div>
                  <Card data-testid="no-environments-empty">
                    <CardHeader>
                      <CardTitle>No environments yet</CardTitle>
                      <CardDescription>
                        A project starts without an environment. Run{" "}
                        <InlineCommand value="dotrelay init" /> in this
                        repository to create its first environment.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </section>
              ) : null}

              {view === "team" ? (
                <section id="administration">
                  <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <h1 className="font-heading text-3xl font-semibold">
                        {selectedTeam?.name ?? "Team"}
                      </h1>
                      <p className="mt-2 text-muted-foreground">
                        {roleDisclosure[effectiveRole]}
                      </p>
                    </div>
                    {displayBoundary.source === "fixture" ||
                    preview === "admin" ? (
                      <div className="flex items-center gap-2">
                        <Label htmlFor="preview-role">Preview role</Label>
                        <select
                          aria-label="Preview role"
                          className="h-9 rounded-lg border border-input bg-input/30 px-3 text-sm"
                          id="preview-role"
                          onChange={(event) =>
                            setRole(event.target.value as MembershipRole)
                          }
                          value={role}
                        >
                          <option value="OWNER">Owner</option>
                          <option value="ADMIN">Admin</option>
                          <option value="MEMBER">Member</option>
                        </select>
                      </div>
                    ) : null}
                  </div>
                  <Alert className="mb-4 bg-card/60">
                    <Users aria-hidden="true" className="text-primary" />
                    <AlertTitle>Your team permissions</AlertTitle>
                    <AlertDescription>
                      {roleDisclosure[effectiveRole]}
                    </AlertDescription>
                  </Alert>
                  <Card data-testid="members-card">
                    <CardHeader>
                      <CardTitle>Members</CardTitle>
                      <CardDescription>
                        The team's members and pending invitations, straight
                        from its record. Invitations go to a GitHub account and
                        expire after seven days.
                      </CardDescription>
                      <CardAction>
                        <Button
                          data-testid="invite-member"
                          disabled={!canAdminister}
                          onClick={openInvitationDialog}
                        >
                          <Users aria-hidden="true" /> Invite member
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      {!apiOrigin ? (
                        <Alert className="bg-card/60">
                          <AlertTitle>Team data unavailable</AlertTitle>
                          <AlertDescription>
                            This deployment doesn't expose a team service, so
                            the member list can't be loaded.
                          </AlertDescription>
                        </Alert>
                      ) : membershipError ? (
                        <Alert className="border-destructive/30 bg-destructive/10">
                          <AlertTitle>Couldn't load team members</AlertTitle>
                          <AlertDescription>{membershipError}</AlertDescription>
                        </Alert>
                      ) : membershipState === null ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                          Loading members…
                        </p>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>User</TableHead>
                              {canAdminister ? (
                                <TableHead>Role</TableHead>
                              ) : null}
                              <TableHead>Status</TableHead>
                              {canAdminister ? (
                                <TableHead>Actions</TableHead>
                              ) : null}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {membershipState.memberships.map((member) => (
                              <TableRow
                                key={member.membershipId}
                                data-testid={`member-row-${member.membershipId}`}
                              >
                                <TableCell>
                                  <div className="font-medium">
                                    {member.name ??
                                      `GitHub ${member.githubSubject}`}
                                  </div>
                                </TableCell>
                                {canAdminister ? (
                                  <TableCell>
                                    {roleLabel(member.role)}
                                  </TableCell>
                                ) : null}
                                <TableCell>
                                  {member.lifecycle === "ACTIVE" ? (
                                    <Badge variant="outline">Active</Badge>
                                  ) : member.lifecycle === "REMOVED" ? (
                                    <Badge variant="secondary">Removed</Badge>
                                  ) : (
                                    <Badge
                                      className="border-amber-300/25 text-amber-200"
                                      variant="outline"
                                    >
                                      Waiting for encryption keys
                                    </Badge>
                                  )}
                                </TableCell>
                                {canAdminister ? (
                                  <TableCell>
                                    {member.lifecycle === "ACTIVE" &&
                                    member.userId !==
                                      displayBoundary.session.userId &&
                                    (effectiveRole === "OWNER" ||
                                      member.role === "MEMBER") ? (
                                      <div className="flex flex-col gap-2">
                                        <div className="flex items-center gap-2">
                                          {effectiveRole === "OWNER" ? (
                                            <select
                                              aria-label={`Role for ${
                                                member.name ??
                                                `GitHub ${member.githubSubject}`
                                              }`}
                                              className="h-8 rounded-lg border border-input bg-input/30 px-2 text-sm"
                                              disabled={memberMutation !== null}
                                              value={member.role ?? "MEMBER"}
                                              onChange={(event) =>
                                                void changeMemberRole(
                                                  member.membershipId,
                                                  event.target
                                                    .value as MembershipRole,
                                                )
                                              }
                                            >
                                              <option value="OWNER">
                                                Owner
                                              </option>
                                              <option value="ADMIN">
                                                Admin
                                              </option>
                                              <option value="MEMBER">
                                                Member
                                              </option>
                                            </select>
                                          ) : null}
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={memberMutation !== null}
                                            onClick={() =>
                                              void removeMember(
                                                member.membershipId,
                                              )
                                            }
                                          >
                                            Remove member
                                          </Button>
                                        </div>
                                        {memberMutationError?.membershipId ===
                                        member.membershipId ? (
                                          <p className="text-xs text-destructive">
                                            {memberMutationError.message}
                                          </p>
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </TableCell>
                                ) : null}
                              </TableRow>
                            ))}
                            {membershipState.invitations.map((invitation) => (
                              <TableRow key={invitation.invitationId}>
                                <TableCell>
                                  <div className="font-medium">Invitation</div>
                                  <div className="font-mono text-[10px] text-muted-foreground">
                                    GitHub {invitation.providerSubject}
                                  </div>
                                </TableCell>
                                {canAdminister ? (
                                  <TableCell>Member</TableCell>
                                ) : null}
                                {canAdminister ? <TableCell /> : null}
                                <TableCell>
                                  <Badge
                                    className="border-amber-300/25 text-amber-200"
                                    variant="outline"
                                  >
                                    Invitation pending · expires{" "}
                                    {formatDate(invitation.expiresAt)}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                            {membershipState.memberships.length === 0 &&
                            membershipState.invitations.length === 0 ? (
                              <TableRow>
                                <TableCell
                                  colSpan={canAdminister ? 4 : 2}
                                  className="text-muted-foreground"
                                >
                                  No members yet.
                                </TableCell>
                              </TableRow>
                            ) : null}
                          </TableBody>
                        </Table>
                      )}
                    </CardContent>
                  </Card>
                  {selectedProject ? (
                    <>
                      <Card className="mt-4">
                        <CardHeader>
                          <CardTitle>
                            {projectDisplayName(selectedProject)}
                          </CardTitle>
                          <CardDescription>
                            Archive this project to let another project use its
                            GitHub repository.
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="flex items-center justify-between gap-4">
                          <Badge
                            data-testid="project-lifecycle"
                            variant={
                              projectLifecycle === "ACTIVE"
                                ? "default"
                                : "secondary"
                            }
                          >
                            {projectLifecycle === "ACTIVE"
                              ? "Active"
                              : "Archived"}
                          </Badge>
                          <LifecycleDialog
                            disabled={!canAdminister}
                            lifecycle={projectLifecycle}
                            onConfirm={() =>
                              void persistProjectLifecycle(
                                projectLifecycle === "ACTIVE"
                                  ? "archive"
                                  : "restore",
                              )
                            }
                            resource="Project"
                          />
                        </CardContent>
                      </Card>
                      {lifecycleError?.resource === "project" ? (
                        <p
                          role="alert"
                          className="mt-2 text-xs font-medium text-destructive"
                        >
                          {lifecycleError.message}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </section>
              ) : null}

              {view === "devices" ? (
                <section id="devices">
                  <h1 className="font-heading text-3xl font-semibold">
                    Devices
                  </h1>
                  <p className="mt-2 max-w-2xl text-muted-foreground">
                    A device is this browser, or the CLI on one of your
                    machines. Signing in alone doesn't let you read secrets.
                  </p>
                  {enrolledDevices.length > 0 ? (
                    <Card className="mt-6">
                      <CardHeader>
                        <CardTitle>Your devices</CardTitle>
                        <CardDescription>
                          Devices set up on your account. A device also needs
                          the project's keys to read its secrets.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Table aria-label="Your devices">
                          <TableHeader>
                            <TableRow>
                              <TableHead>Device</TableHead>
                              <TableHead>Project access</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {enrolledDevices.map((device) => (
                              <TableRow
                                data-testid={`enrolled-device-${device.id}`}
                                key={device.id}
                              >
                                <TableCell>
                                  <div className="font-medium">
                                    {device.name ??
                                      (device.current
                                        ? "This browser"
                                        : "Device")}
                                  </div>
                                  <div className="font-mono text-[10px] text-muted-foreground">
                                    {device.id}
                                  </div>
                                  {device.current &&
                                  device.osName &&
                                  device.clientSummary ? (
                                    <div className="text-xs text-muted-foreground">
                                      {device.clientSummary}
                                      {device.osName
                                        ? ` · ${device.osName}`
                                        : ""}
                                    </div>
                                  ) : device.clientSummary ? (
                                    <div className="text-xs text-muted-foreground">
                                      {device.clientSummary}
                                    </div>
                                  ) : null}
                                  {device.current ? (
                                    deviceRenameOpen ? (
                                      <div className="mt-2 flex max-w-xs items-center gap-2">
                                        <Input
                                          aria-label="Device name"
                                          className="h-8"
                                          data-testid="device-rename-input"
                                          maxLength={64}
                                          value={deviceRenameValue}
                                          onChange={(event) =>
                                            setDeviceRenameValue(
                                              event.target.value,
                                            )
                                          }
                                          onKeyDown={(event) => {
                                            if (event.key === "Enter")
                                              void renameCurrentDevice();
                                            if (event.key === "Escape")
                                              setDeviceRenameOpen(false);
                                          }}
                                        />
                                        <Button
                                          disabled={
                                            deviceRenameBusy ||
                                            deviceRenameValue.trim().length ===
                                              0
                                          }
                                          size="sm"
                                          type="button"
                                          data-testid="device-rename-save"
                                          onClick={() =>
                                            void renameCurrentDevice()
                                          }
                                        >
                                          Save
                                        </Button>
                                        <Button
                                          disabled={deviceRenameBusy}
                                          size="sm"
                                          type="button"
                                          variant="ghost"
                                          onClick={() => {
                                            setDeviceRenameOpen(false);
                                            setDeviceRenameError(null);
                                          }}
                                        >
                                          Cancel
                                        </Button>
                                        {deviceRenameError ? (
                                          <p className="text-xs text-destructive">
                                            {deviceRenameError}
                                          </p>
                                        ) : null}
                                      </div>
                                    ) : (
                                      <Button
                                        className="mt-2"
                                        size="sm"
                                        type="button"
                                        variant="outline"
                                        data-testid="device-rename-open"
                                        onClick={() => {
                                          setDeviceRenameValue(
                                            device.name ?? "",
                                          );
                                          setDeviceRenameError(null);
                                          setDeviceRenameOpen(true);
                                        }}
                                      >
                                        Rename
                                      </Button>
                                    )
                                  ) : null}
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    className={
                                      device.hasEpochGrant
                                        ? undefined
                                        : "border-amber-300/25 text-amber-200"
                                    }
                                    variant="outline"
                                  >
                                    {device.hasEpochGrant
                                      ? "Has project access"
                                      : "Waiting for project keys"}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </CardContent>
                    </Card>
                  ) : null}
                  <Card
                    className={enrolledDevices.length > 0 ? "mt-4" : "mt-6"}
                  >
                    <CardHeader>
                      <CardTitle>
                        {thisBrowserEnrolled
                          ? "This browser is set up"
                          : "Set up this browser"}
                      </CardTitle>
                      <CardDescription>
                        {thisBrowserEnrolled
                          ? "This browser has saved its device keys. It also needs the project's keys to read its secrets."
                          : "This creates a key pair in this browser. The CLI on this machine is a separate device."}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Prefer the CLI? It sets up the CLI on this machine, not
                        this browser.
                      </p>
                      <CopyableCommand
                        data-testid="cli-setup-command"
                        value={cliCommand}
                      />
                      {deviceSetupMessage ? (
                        <p className="mt-3 text-sm text-muted-foreground">
                          <CommandText text={deviceSetupMessage} />
                        </p>
                      ) : null}
                    </CardContent>
                    {!thisBrowserEnrolled ? (
                      <CardFooter>
                        <Button
                          disabled={deviceSetupInProgress}
                          onClick={() => void provisionBrowserDevice()}
                        >
                          {deviceSetupInProgress
                            ? "Setting up…"
                            : "Set up browser"}
                        </Button>
                      </CardFooter>
                    ) : null}
                  </Card>
                </section>
              ) : null}
              {view === "recovery" ? (
                <RecoveryArea
                  accountUnlocked={accountUnlocked}
                  addPassword={addPassword}
                  addPasswordOpen={addPasswordOpen}
                  connection={connection}
                  deviceActive={boundary.device.active}
                  deviceSetupInProgress={deviceSetupInProgress}
                  onAddPassword={setAddPassword}
                  onAddPasswordOpen={setAddPasswordOpen}
                  onAddEncryptionPassword={addEncryptionPasswordHandler}
                  onAddPasskey={addPasskeyHandler}
                  onDeviceSetup={provisionBrowserDevice}
                  onPassword={setPassword}
                  password={password}
                  onRemovePasskeyDialogOpen={setRemovePasskeyDialogOpen}
                  onRemovePasswordDialogOpen={setRemovePasswordDialogOpen}
                  onRetry={requestRetry}
                  onRotateRecoveryCode={rotateRecoveryCodeHandler}
                  onSendTransfer={sendAccountKeyTransferHandler}
                  onSetupRecovery={setupAccountRecoveryHandler}
                  onTransferIdInput={setTransferIdInput}
                  onTransferTarget={setTransferTarget}
                  onUnlock={unlockAccountHandler}
                  onUnlockInput={setUnlockInput}
                  onUnlockMethodSelected={(method) => {
                    setUnlockMethod(method);
                    setRecoveryError(null);
                  }}
                  passkeyAvailable={passkeyAvailable}
                  peerDevices={boundary.peerDevices}
                  recoveryBusy={recoveryBusy}
                  recoveryError={recoveryError}
                  recoveryMessage={recoveryMessage}
                  recoveryWrappers={recoveryWrappers}
                  sentTransfer={sentTransfer}
                  sessionActive={sessionActive}
                  transferIdInput={transferIdInput}
                  transferTarget={transferTarget}
                  unlockInput={unlockInput}
                  unlockMethod={unlockMethod}
                  unlockMethodOffers={unlockMethodOffers}
                />
              ) : null}

              <section
                aria-hidden={envVisible ? undefined : true}
                className={envVisible ? undefined : "hidden"}
              >
                {editorEntries.map((entry) => {
                  const entryKey = environmentContextKey(entry.identity);
                  const isCurrent =
                    selectedEntry !== null && entryKey === currentKey;
                  return (
                    <div
                      className={isCurrent ? undefined : "hidden"}
                      data-testid={
                        isCurrent
                          ? "editor-context-active"
                          : "editor-context-retained"
                      }
                      key={entryKey}
                    >
                      <EnvironmentEditor
                        active={envVisible && isCurrent}
                        available={
                          isCurrent
                            ? entry.available && !contextStale
                            : entry.available
                        }
                        contextIdentity={entry.identity}
                        loading={isCurrent && contextStale}
                        role={teamRoleFor(entry.identity.teamId)}
                        onDraftDirtyChange={(dirty, changedVariableNames) => {
                          draftStateRef.current.set(entryKey, {
                            dirty,
                            changedVariableNames,
                          });
                        }}
                        onSetupAction={handleSetupAction}
                        protocolSession={entry.session ?? protocolSession}
                        setupAction={entry.setupAction}
                        setupBusy={isCurrent ? deviceSetupInProgress : false}
                        setupCommand={entry.setupCommand}
                        setupMessage={entry.setupMessage}
                      />
                    </div>
                  );
                })}
              </section>
            </>
          )}
        </main>
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) resetInvitationDialog();
          setInvitationOpen(open);
        }}
        open={invitationOpen}
      >
        <DialogContent data-testid="invitation-dialog">
          <DialogHeader>
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>
              Invitations go to a GitHub account, not an email address. Each
              invitation works once and expires after seven days.
            </DialogDescription>
          </DialogHeader>
          {inviteError ? (
            <Alert className="border-destructive/30 bg-destructive/10">
              <AlertTitle>
                {inviteStep === "confirmed"
                  ? "Couldn't create the invitation"
                  : "Couldn't resolve that login"}
              </AlertTitle>
              <AlertDescription>{inviteError}</AlertDescription>
            </Alert>
          ) : null}
          {inviteStep === "form" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="github-login">GitHub login</Label>
                <Input
                  autoComplete="off"
                  disabled={inviteBusy}
                  id="github-login"
                  onChange={(event) => setInviteLogin(event.target.value)}
                  placeholder="octocat"
                  value={inviteLogin}
                />
              </div>
              <Alert className="bg-muted/30">
                <AlertTitle>Pending after acceptance</AlertTitle>
                <AlertDescription>
                  New members stay pending until they've received the encryption
                  keys their device needs.
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button
                  data-testid="resolve-login"
                  disabled={!inviteLogin.trim() || inviteBusy}
                  onClick={() => void resolveInvitation()}
                >
                  {inviteBusy ? "Resolving…" : "Resolve"}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-input bg-input/30 p-3">
                <div className="font-medium">@{inviteResolved?.login}</div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  GitHub ID {inviteResolved?.githubUserId}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  This invitation expires in seven days.
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={inviteBusy}
                  onClick={() => {
                    setInviteStep("form");
                    setInviteResolved(null);
                    setInviteError(null);
                  }}
                >
                  Back
                </Button>
                <Button
                  data-testid="create-invitation"
                  disabled={inviteBusy}
                  onClick={() => void createInvitation()}
                >
                  {inviteBusy ? "Creating…" : "Create invitation"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (open) return;
          const restore = promptRestoreRef.current;
          promptRestoreRef.current = null;
          setPendingSwitch(null);
          // Dismissing via the close control or Escape counts as staying, so
          // a prompt opened by Back/Forward returns to the entry left behind.
          if (restore) restoreHistoryEntry(restore);
        }}
        open={pendingSwitch !== null}
      >
        <DialogContent data-testid="switch-draft-prompt">
          <DialogHeader>
            <DialogTitle>
              {switchRebinding ? "Switch servers?" : "Keep unsaved changes?"}
            </DialogTitle>
            <DialogDescription>
              {pendingSwitch
                ? switchRebinding
                  ? `You have unsaved changes in ${
                      pendingSwitch.details.length === 1
                        ? pendingSwitch.details[0]
                        : `${pendingSwitch.details.length} environments in ${pendingSwitch.leavingLabel}`
                    }. Switching to ${pendingSwitch.targetLabel ?? "another server"} discards them and cancels any operations still in progress.`
                  : `You have unsaved changes in ${pendingSwitch.leavingLabel}${pendingSwitch.details.length > 0 ? ` (${pendingSwitch.details.join(", ")})` : ""}. Keep them to find the draft again when you return, or discard them. Discarding throws away those changes and cancels any operations still in progress for this environment.`
                : "You have unsaved changes in the current environment."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                const restore = promptRestoreRef.current;
                promptRestoreRef.current = null;
                setPendingSwitch(null);
                if (restore) restoreHistoryEntry(restore);
              }}
            >
              {switchRebinding ? "Stay" : "Cancel"}
            </Button>
            {!switchRebinding ? (
              <Button
                data-testid="switch-keep-draft"
                onClick={() => {
                  if (pendingSwitch)
                    applySelection(pendingSwitch.target, {
                      // A prompt opened by Back/Forward already sits on the
                      // target entry; pushing again would duplicate it.
                      push: pendingSwitch.restore === undefined,
                      discard: false,
                    });
                }}
              >
                Keep draft
              </Button>
            ) : null}
            <Button
              data-testid="switch-discard-draft"
              variant="destructive"
              onClick={() => {
                if (pendingSwitch)
                  applySelection(pendingSwitch.target, {
                    push: pendingSwitch.restore === undefined,
                    discard: true,
                  });
              }}
            >
              {switchRebinding ? "Discard and switch" : "Discard changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (open) return;
          setTrustDialogOpen(false);
          setTrustBlocked(null);
        }}
        open={trustDialogOpen}
      >
        <DialogContent data-testid="trust-server-dialog">
          <DialogHeader>
            <DialogTitle>Confirm server trust</DialogTitle>
            <DialogDescription>
              This records a trust decision in this browser for the exact server
              below. It is saved for that origin and server identity only, never
              reused for a different one, and a change to either asks you to
              confirm again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Server origin</Label>
              <p className="font-mono text-sm">{boundary.profile.origin}</p>
            </div>
            <div>
              <Label>Server identity</Label>
              <p className="font-mono text-sm">
                {boundary.profile.serverProfileId ?? "unavailable"}
              </p>
            </div>
            {boundary.profile.serverProfileId === undefined ? (
              <Alert className="border-amber-300/30 bg-amber-300/5">
                <AlertTitle>Identity unavailable</AlertTitle>
                <AlertDescription>
                  This server didn't report a stable identity, so this browser
                  can't trust it.
                </AlertDescription>
              </Alert>
            ) : null}
            {trustBlocked ? (
              <Alert className="border-destructive/30 bg-destructive/10">
                <AlertTitle>Couldn't save the trust decision</AlertTitle>
                <AlertDescription>{trustBlocked}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              data-testid="trust-server-confirm"
              disabled={
                trustDialogBusy ||
                boundary.profile.serverProfileId === undefined
              }
              onClick={() => void confirmTrust()}
            >
              {trustDialogBusy ? "Saving…" : "Confirm trust"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => setReplacementDialogOpen(open)}
        open={replacementDialogOpen}
      >
        <DialogContent data-testid="replace-device-dialog" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Replace this browser's device?</DialogTitle>
            <DialogDescription>
              This browser's stored keys can't restore the project's current
              keys. Replacing the Device creates a new set of keys on this
              machine and discards the stored keys for the current Device. The
              current Device stays active on the server.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              data-testid="replace-device-confirm"
              disabled={deviceSetupInProgress}
              onClick={() => {
                setReplacementDialogOpen(false);
                void provisionBrowserDevice();
              }}
            >
              {deviceSetupInProgress ? "Setting up…" : "Replace device"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RecoveryCodeDialog
        busy={recoveryBusy}
        code={recoveryCode}
        error={recoveryError}
        note={recoveryCodeNote}
        onConfirm={confirmRecoveryCodeHandler}
        onDismiss={dismissRecoveryCodeHandler}
      />

      <RemovePasswordDialog
        busy={recoveryBusy}
        onConfirm={removeEncryptionPasswordHandler}
        onDialogOpen={setRemovePasswordDialogOpen}
        open={removePasswordDialogOpen}
      />

      <RemovePasskeyDialog
        busy={recoveryBusy}
        onConfirm={removePasskeyHandler}
        onDialogOpen={setRemovePasskeyDialogOpen}
        open={removePasskeyDialogOpen}
      />
    </div>
  );
};
