"use client";

import {
  createBrowserDeviceStorage,
  createBrowserProfilePinStore,
  createDeviceBootstrap,
  createProjectEpochGrantBootstrap,
  createProtocolTransport,
  type DeviceBootstrap,
  type DeviceKeyMaterial,
  loadDeviceKeyMaterial,
  openProjectEpochGrant,
  probeBrowserDeviceStorage,
  uuidToBytes,
} from "@dotrelay/client";
import {
  Archive,
  Braces,
  ChevronRight,
  FolderGit2,
  KeyRound,
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
  probeBrowserLocalStorage,
  readStoredBrowserDeviceId,
  writeStoredBrowserDeviceId,
} from "@/lib/browser-storage";
import {
  type EnvironmentContextIdentity,
  environmentContextIdentity,
  environmentContextKey,
  planContextSwitch,
} from "@/lib/environment-context";
import {
  createEnvironmentProtocolSession,
  type EnvironmentProtocolSession,
} from "@/lib/environment-protocol-session";
import {
  displayedSetupAction,
  isPrivilegedRole,
  nextSetupAction,
  type SetupAction,
} from "@/lib/environment-workflow";
import {
  acceptTeamInvitation,
  createTeamInvitation,
  fetchMyInvitations,
  fetchTeamMemberships,
  type MyInvitations,
  type ResolvedGitHubUser,
  resolveGitHubLogin,
  type TeamMembershipState,
} from "@/lib/team-administration";
import { cn } from "@/lib/utils";
import {
  emptyWorkspaceBoundary,
  enrolledDeviceRows,
  fetchWorkspaceBoundary,
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

type PendingEnrollment = Readonly<{
  readonly bootstrap: DeviceBootstrap;
  readonly operationId: string;
}>;

const environmentDisplayLabel = (
  environment: WorkspaceProject["environments"][number] | null | undefined,
  project: WorkspaceProject | null | undefined,
): string =>
  environment && project
    ? `${environment.label} · ${projectDisplayName(project)}`
    : (environment?.label ?? "an environment");

const WORKSPACE_REFRESH_MS = Math.max(
  Number(process.env.NEXT_PUBLIC_DOTRELAY_WORKSPACE_REFRESH_MS ?? 0) || 30_000,
  1_000,
);
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

// The deployment decides which Server Profile this shell is bound to. Only
// the explicit development fixture keeps the URL-driven preview selector, so
// a live deployment can never be pointed at another backend from the browser.
const DEPLOYMENT_PROFILE_ID: WorkspaceProfileId = resolveWorkspaceProfileId();
const WORKSPACE_FIXTURE =
  process.env.NEXT_PUBLIC_DOTRELAY_WORKSPACE_FIXTURE === "1";

const bytesToHex = (value: Uint8Array): string =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hexToBytes = (value: string): Uint8Array => {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0)
    throw new Error("invalid hex");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

const toBase64 = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const roleDisclosure: Readonly<Record<MembershipRole, string>> = {
  OWNER: "Owners can manage team members, projects, and environments.",
  ADMIN:
    "Admins can invite members and manage projects and environments. They cannot change owners or other admins.",
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
    return {
      ...boundary,
      device: protectedPreview
        ? { active: true, label: "Active device" }
        : boundary.device,
      grantsReady: protectedPreview ? true : boundary.grantsReady,
      epochCurrent: protectedPreview ? true : boundary.epochCurrent,
      rotationRequired: protectedPreview ? false : boundary.rotationRequired,
      crypto: cryptoAvailable
        ? { available: true }
        : {
            available: false,
            problemCode: "crypto_provider_unavailable" as const,
          },
    };
  }, [boundary, browserCrypto, noCryptoPreview, protectedPreview]);
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
    const nextPreview = params.get("preview");
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

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = RECONNECT_BASE_MS;
    const stale = (run: number) => cancelled || run !== generation;
    const loadOnce = async (run: number): Promise<boolean> => {
      try {
        const fetched = await fetchWorkspaceBoundary(profileId, {
          ...(environmentId ? { environmentId } : {}),
        });
        if (stale(run)) return false;
        if (fetched.connection !== "online") {
          setConnection("offline");
          return false;
        }
        const serverProfileId = fetched.profile.serverProfileId;
        const storedId = serverProfileId
          ? readStoredBrowserDeviceId(fetched.profile.origin, serverProfileId)
          : null;
        const resolved =
          storedId && storedId !== fetched.device.id
            ? await fetchWorkspaceBoundary(profileId, {
                deviceId: storedId,
                ...(environmentId ? { environmentId } : {}),
              })
            : fetched;
        if (stale(run)) return false;
        if (resolved.connection !== "online") {
          setConnection("offline");
          return false;
        }
        setVerifiedAt(Date.now());
        setConnection("online");
        const resolvedJson = JSON.stringify(resolved);
        if (resolvedJson !== boundaryJsonRef.current) {
          boundaryJsonRef.current = resolvedJson;
          setBoundary(resolved);
        }
        if (!storedId) {
          removeSessionByKey(
            environmentContextKey(
              environmentContextIdentity({
                profileId,
                serverProfileId: resolved.profile.serverProfileId,
                teamId,
                projectId,
                environmentId,
              }),
            ),
          );
        }
        return true;
      } catch {
        if (!stale(run)) setConnection("offline");
        return false;
      }
    };
    const tick = async () => {
      const run = ++generation;
      const online = await loadOnce(run);
      if (stale(run)) return;
      if (online) {
        reconnectDelay = RECONNECT_BASE_MS;
        timer = setTimeout(() => void tick(), WORKSPACE_REFRESH_MS);
      } else {
        timer = setTimeout(() => void tick(), reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      }
    };
    const reconnectNow = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      reconnectDelay = RECONNECT_BASE_MS;
      void tick();
    };
    reconnectNowRef.current = reconnectNow;
    void tick();
    return () => {
      cancelled = true;
      reconnectNowRef.current = null;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [profileId, teamId, projectId, environmentId, removeSessionByKey]);

  useEffect(() => {
    let cancelled = false;
    const targetKey = environmentContextKey(
      environmentContextIdentity({
        profileId,
        serverProfileId: boundary.profile.serverProfileId,
        teamId,
        projectId,
        environmentId,
      }),
    );
    const boundaryMatchesSelection =
      environmentId === null ||
      (boundary.environment.id === environmentId &&
        boundary.environment.projectId === projectId &&
        boundary.environment.teamId === teamId);
    const clearSelectedSession = () => {
      if (cancelled) return;
      removeSessionByKey(targetKey);
    };
    const settleContext = () => {
      if (!cancelled) setContextStale(false);
    };
    const loadSession = async () => {
      const environment = boundary.environment;
      const device = boundary.device;
      const profile = boundary.profile;
      if (
        !boundary.session.userId ||
        !profile.serverProfileId ||
        !device.active ||
        !device.id ||
        !device.encryptionPublicKey ||
        !device.signingPublicKey ||
        !environment.id ||
        !environment.projectId ||
        !environment.teamId
      ) {
        clearSelectedSession();
        if (boundaryMatchesSelection) settleContext();
        return;
      }
      try {
        const pin = {
          serverProfileId: profile.serverProfileId,
          origin: profile.origin,
        };
        const storage = createBrowserDeviceStorage(pin);
        const durable = storage.durable;
        const bundle = await storage.load({
          pin,
          deviceId: uuidToBytes(device.id),
        });
        const keyMaterial = await loadDeviceKeyMaterial(bundle);
        if (!keyMaterial.encryptionPublicKey)
          throw new Error("stored Device public key is missing");
        const expectedHeadId =
          boundary.environment.headRevision === "empty-environment"
            ? null
            : boundary.environment.headRevision;
        const context = {
          serverProfileId: profile.serverProfileId,
          teamId: environment.teamId,
          projectId: environment.projectId,
          environmentId: environment.id,
          actorUserId: boundary.session.userId,
          actorDeviceId: device.id,
          projectEpoch: Number(environment.projectEpoch ?? 1),
          expectedHeadId,
          expectedHeadHash: environment.headHash
            ? hexToBytes(environment.headHash)
            : null,
          trustedRevisionId: environment.id,
          trustedRevisionHash: new Uint8Array(48),
          valueRecipientPublicKey: keyMaterial.encryptionPublicKey,
          userDefinedValueRecipientPublicKey: keyMaterial.encryptionPublicKey,
          signingPrivateKey: keyMaterial.signingPrivateKey,
          revisionSigningPublicKey: hexToBytes(device.signingPublicKey),
        };
        const transport = createProtocolTransport({ origin: profile.origin });
        const signingTrustKeys = (boundary.signingTrustKeys ?? [])
          .map((key) => {
            try {
              return hexToBytes(key);
            } catch {
              return null;
            }
          })
          .filter((key): key is Uint8Array => key !== null);
        let sharedValueSecret: Uint8Array | undefined;
        if (boundary.epochGrant) {
          try {
            sharedValueSecret = await openProjectEpochGrant(
              fromBase64(boundary.epochGrant),
              keyMaterial.encryptionPrivateKey,
            );
          } catch {
            sharedValueSecret = undefined;
          }
        }
        const session = createEnvironmentProtocolSession({
          context,
          transport,
          sharedValuePrivateKey: keyMaterial.encryptionPrivateKey,
          userDefinedValuePrivateKey: keyMaterial.encryptionPrivateKey,
          signingTrustKeys:
            signingTrustKeys.length > 0
              ? signingTrustKeys
              : [hexToBytes(device.signingPublicKey)],
          ...(sharedValueSecret ? { sharedValueSecret } : {}),
        });
        if (cancelled) return;
        if (
          environment.id !== environmentId ||
          environment.projectId !== projectId ||
          environment.teamId !== teamId
        ) {
          clearSelectedSession();
          return;
        }
        if (durable)
          durableBrowserDeviceRef.current.add(
            `${pin.origin}\u0000${pin.serverProfileId}`,
          );
        setSessionsByKey((prev) => new Map(prev).set(targetKey, session));
        settleContext();
      } catch {
        clearSelectedSession();
        if (boundaryMatchesSelection) settleContext();
      }
    };
    void loadSession();
    return () => {
      cancelled = true;
    };
  }, [
    boundary,
    profileId,
    teamId,
    projectId,
    environmentId,
    removeSessionByKey,
  ]);

  const provisionBrowserDevice = async () => {
    const apiOrigin = resolveApiOrigin() ?? boundary.profile.origin;
    if (!boundary.session.userId || !boundary.profile.serverProfileId) {
      setDeviceSetupMessage("Sign in before setting up this browser.");
      return;
    }
    const pin = {
      serverProfileId: boundary.profile.serverProfileId,
      origin: boundary.profile.origin,
    };
    const pinKey = `${pin.origin}\u0000${pin.serverProfileId}`;
    setDeviceSetupInProgress(true);
    setDeviceSetupMessage(null);
    try {
      // Preflight durable storage before creating a Device on the Server
      // Profile: with only a memory fallback or blocked local storage the
      // keys could not survive a reload, so no Device is created at all.
      const recordsProbe = await probeBrowserDeviceStorage();
      if (!recordsProbe.durable) {
        setDeviceSetupMessage(
          "This browser can't save keys in persistent storage. Reloading would lose them, so we haven't set this browser up. Allow site storage, then try again.",
        );
        return;
      }
      if (!probeBrowserLocalStorage()) {
        setDeviceSetupMessage(
          "This browser blocks local storage and can't remember its device ID after a reload. We haven't set it up. Allow local storage, then try again.",
        );
        return;
      }
      // Reuse the pending keys and operation identity from an earlier
      // attempt so a retry replays the same bootstrap instead of creating a
      // duplicate remote Device.
      const pending = pendingEnrollmentRef.current.get(pinKey);
      const bootstrap =
        pending?.bootstrap ??
        (await createDeviceBootstrap({
          pin,
          userId: boundary.session.userId,
        }));
      const operationId =
        pending?.operationId ?? globalThis.crypto.randomUUID();
      if (!pending)
        pendingEnrollmentRef.current.set(
          pinKey,
          Object.freeze({ bootstrap, operationId }),
        );
      const response = await fetch(`${apiOrigin}/api/v1/devices/bootstrap`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId,
          deviceId: bootstrap.deviceId,
          identityGeneration: bootstrap.identityGeneration,
          keyId: bytesToHex(bootstrap.keyId),
          x25519PublicKey: bytesToHex(bootstrap.x25519PublicKey),
          ed25519PublicKey: bytesToHex(bootstrap.ed25519PublicKey),
          certificateId: bootstrap.certificate.id,
          certificate: toBase64(bootstrap.certificate.canonicalBytes),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          readonly code?: unknown;
        } | null;
        if (body?.code === "authentication_required")
          throw new Error("Sign in before setting up this browser.");
        if (body?.code === "state_conflict")
          throw new Error("We couldn't set up this browser. Try again.");
        throw new Error("The server rejected this browser.");
      }
      const persistDeviceLocally = async (): Promise<
        "complete" | "records" | "device-id"
      > => {
        try {
          await createBrowserDeviceStorage(pin).save(bootstrap.bundle);
        } catch {
          return "records";
        }
        try {
          writeStoredBrowserDeviceId(
            pin.origin,
            pin.serverProfileId,
            bootstrap.deviceId,
          );
        } catch {
          return "device-id";
        }
        // Verify from a fresh storage instance that a reload could recover
        // the bundle before durable enrollment is claimed.
        try {
          const verifyStorage = createBrowserDeviceStorage(pin);
          await verifyStorage.load({
            pin,
            deviceId: uuidToBytes(bootstrap.deviceId),
          });
        } catch {
          return "records";
        }
        return readStoredBrowserDeviceId(pin.origin, pin.serverProfileId) ===
          bootstrap.deviceId
          ? "complete"
          : "device-id";
      };
      const persistence = await persistDeviceLocally();
      if (persistence === "complete") {
        pendingEnrollmentRef.current.delete(pinKey);
        durableBrowserDeviceRef.current.add(pinKey);
        const environment = {
          projectId: selectedProject?.id ?? boundary.environment.projectId,
          teamId: selectedTeam?.id ?? boundary.environment.teamId,
          projectEpoch: boundary.environment.projectEpoch,
        };
        const otherDeviceExists =
          Boolean(boundary.device.active) &&
          boundary.device.id !== bootstrap.deviceId;
        if (
          !otherDeviceExists &&
          environment.projectId &&
          environment.teamId &&
          environment.projectEpoch &&
          bootstrap.keyMaterial.encryptionPublicKey
        ) {
          const grant = await createProjectEpochGrantBootstrap({
            serverProfileId: boundary.profile.serverProfileId,
            teamId: environment.teamId,
            projectId: environment.projectId,
            projectEpoch: Number(environment.projectEpoch),
            senderDeviceId: bootstrap.deviceId,
            recipientDeviceId: bootstrap.deviceId,
            recipientX25519PublicKey: bootstrap.x25519PublicKey,
            recipientEncryptionPublicKey:
              bootstrap.keyMaterial.encryptionPublicKey,
            signingPrivateKey: bootstrap.keyMaterial.signingPrivateKey,
          });
          const grantResponse = await fetch(
            `${apiOrigin}/api/v1/grants/bootstrap`,
            {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                "X-DotRelay-Device-Id": bootstrap.deviceId,
              },
              body: JSON.stringify({
                operationId: globalThis.crypto.randomUUID(),
                objectId: grant.objectId,
                projectId: environment.projectId,
                teamId: environment.teamId,
                digest: toBase64(grant.digest),
                grant: toBase64(grant.canonicalBytes),
              }),
            },
          );
          if (!grantResponse.ok)
            setDeviceSetupMessage(
              "This browser is set up. Access to this project's secrets is still pending.",
            );
        }
      }
      const nextBoundary = await fetchWorkspaceBoundary(profileId, {
        deviceId: bootstrap.deviceId,
        ...(selectedEnvironment?.id
          ? { environmentId: selectedEnvironment.id }
          : environmentId
            ? { environmentId }
            : {}),
      });
      if (nextBoundary.connection === "online") {
        commitBoundary(nextBoundary);
      } else {
        setConnection("offline");
      }
      if (persistence === "complete") {
        setDeviceSetupMessage((current) =>
          current?.includes("pending")
            ? current
            : "This browser is set up. Its private keys stay on this machine.",
        );
      } else if (persistence === "records") {
        setDeviceSetupMessage(
          "The server set this browser up, but the browser couldn't save its keys. Access won't survive a reload. Retry setup to save the keys.",
        );
      } else {
        setDeviceSetupMessage(
          "The server set this browser up, but the browser couldn't save its device ID. Access won't survive a reload. Retry setup to save the ID.",
        );
      }
    } catch (error) {
      setDeviceSetupMessage(
        error instanceof Error
          ? error.message
          : "We couldn't finish setting up this browser.",
      );
    } finally {
      setDeviceSetupInProgress(false);
    }
  };

  // The stale-epoch repair reuses what this browser already holds before it
  // proposes a Device replacement. It re-verifies the boundary first: the
  // current grant may have been provisioned in the meantime by another of
  // the User's Devices or by a CLI run. If the keys are still missing, the
  // stored Device keys sign a fresh grant for the current epoch, which
  // discards nothing local. Only when the stored keys are unusable, or the
  // service deactivated the Device, is a replacement Device proposed, and
  // that discards the browser's stored keys, so it asks for approval first.
  const recoveredProjectAccess = (candidate: WorkspaceBoundary): boolean =>
    candidate.device.active && candidate.grantsReady && candidate.epochCurrent;
  const repairStaleEpoch = async () => {
    const profile = boundary.profile;
    const device = boundary.device;
    const apiOrigin = resolveApiOrigin() ?? profile.origin;
    if (!boundary.session.userId) {
      setDeviceSetupMessage("Sign in before restoring this browser's keys.");
      return;
    }
    if (!profile.serverProfileId || !device.active || !device.id) {
      setReplacementDialogOpen(true);
      return;
    }
    const pin = {
      serverProfileId: profile.serverProfileId,
      origin: profile.origin,
    };
    setDeviceSetupInProgress(true);
    setDeviceSetupMessage(null);
    try {
      const storedId = readStoredBrowserDeviceId(
        pin.origin,
        pin.serverProfileId,
      );
      const nextBoundary = await fetchWorkspaceBoundary(profileId, {
        ...(storedId ? { deviceId: storedId } : {}),
        ...(selectedEnvironment?.id
          ? { environmentId: selectedEnvironment.id }
          : environmentId
            ? { environmentId }
            : {}),
      });
      if (nextBoundary.connection !== "online") {
        setConnection("offline");
        setDeviceSetupMessage(
          "Couldn't reach the server, so the keys couldn't be restored. Try again.",
        );
        return;
      }
      commitBoundary(nextBoundary);
      if (recoveredProjectAccess(nextBoundary)) {
        // The unblocked editor is the result report: nothing needs saying.
        return;
      }
      // The stored Device keys sign the fresh grant; a mismatch between the
      // stored public key and the service's record means these keys belong
      // to a different Device and cannot be used.
      let keyMaterial: DeviceKeyMaterial | null = null;
      let x25519PublicKey: Uint8Array | null = null;
      if (storedId === device.id && device.encryptionPublicKey) {
        try {
          const storage = createBrowserDeviceStorage(pin);
          const bundle = await storage.load({
            pin,
            deviceId: uuidToBytes(device.id),
          });
          const material = await loadDeviceKeyMaterial(bundle);
          if (material.encryptionPublicKey) {
            const exported = new Uint8Array(
              await globalThis.crypto.subtle.exportKey(
                "raw",
                material.encryptionPublicKey,
              ),
            );
            if (bytesToHex(exported) === device.encryptionPublicKey) {
              keyMaterial = material;
              x25519PublicKey = exported;
            }
          }
        } catch {
          keyMaterial = null;
        }
      }
      const teamId = nextBoundary.environment.teamId ?? null;
      const projectId = nextBoundary.environment.projectId ?? null;
      const projectEpoch = Number(nextBoundary.environment.projectEpoch);
      if (
        keyMaterial?.encryptionPublicKey &&
        x25519PublicKey &&
        teamId &&
        projectId &&
        Number.isSafeInteger(projectEpoch) &&
        projectEpoch >= 1
      ) {
        const grant = await createProjectEpochGrantBootstrap({
          serverProfileId: profile.serverProfileId,
          teamId,
          projectId,
          projectEpoch,
          senderDeviceId: device.id,
          recipientDeviceId: device.id,
          recipientX25519PublicKey: x25519PublicKey,
          recipientEncryptionPublicKey: keyMaterial.encryptionPublicKey,
          signingPrivateKey: keyMaterial.signingPrivateKey,
        });
        const response = await fetch(`${apiOrigin}/api/v1/grants/bootstrap`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-DotRelay-Device-Id": device.id,
          },
          body: JSON.stringify({
            operationId: globalThis.crypto.randomUUID(),
            objectId: grant.objectId,
            projectId,
            teamId,
            digest: toBase64(grant.digest),
            grant: toBase64(grant.canonicalBytes),
          }),
        });
        if (response.ok) {
          const refreshed = await fetchWorkspaceBoundary(profileId, {
            deviceId: device.id,
            ...(selectedEnvironment?.id
              ? { environmentId: selectedEnvironment.id }
              : environmentId
                ? { environmentId }
                : {}),
          });
          if (refreshed.connection === "online") commitBoundary(refreshed);
          else setConnection("offline");
          setDeviceSetupMessage(
            recoveredProjectAccess(refreshed)
              ? null
              : "The server accepted the new keys, but project access is still pending. Try again.",
          );
          return;
        }
        const body = (await response.json().catch(() => null)) as {
          readonly code?: unknown;
        } | null;
        const code = typeof body?.code === "string" ? body.code : null;
        if (code === "device_not_active") {
          // The service deactivated the Device, so its keys can no longer
          // sign; only a replacement Device recovers this browser.
          setReplacementDialogOpen(true);
          return;
        }
        if (code === "stale_epoch") {
          setDeviceSetupMessage(
            "Key rotation is still in progress on this project. Wait for it to finish, then try again.",
          );
          return;
        }
        const teamName =
          nextBoundary.catalog.teams.find((team) => team.id === teamId)?.name ??
          selectedTeam?.name ??
          "your team";
        setDeviceSetupMessage(
          `This browser can't recover the project's current keys on its own. Run \`bun apps/cli/src/index.ts pull\` on another of your devices to hand the keys over, or restore a Device from a Recovery Kit. ${teamName}'s Owners and Admins can also rotate the project's keys.`,
        );
        return;
      }
      // No usable local keys for this Device: the only repair is a
      // replacement Device, which discards the browser's stored keys.
      setReplacementDialogOpen(true);
    } catch {
      setDeviceSetupMessage("Couldn't restore the project's keys. Try again.");
    } finally {
      setDeviceSetupInProgress(false);
    }
  };

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
      void (async () => {
        setDeviceSetupInProgress(true);
        try {
          const storedId = boundary.profile.serverProfileId
            ? readStoredBrowserDeviceId(
                boundary.profile.origin,
                boundary.profile.serverProfileId,
              )
            : null;
          const nextBoundary = await fetchWorkspaceBoundary(profileId, {
            ...(storedId ? { deviceId: storedId } : {}),
            ...(selectedEnvironment?.id
              ? { environmentId: selectedEnvironment.id }
              : environmentId
                ? { environmentId }
                : {}),
          });
          if (nextBoundary.connection !== "online") {
            setConnection("offline");
            setDeviceSetupMessage("Couldn't refresh project access.");
          } else {
            commitBoundary(nextBoundary);
            setDeviceSetupMessage(
              nextBoundary.grantsReady
                ? null
                : "This browser doesn't have the project's keys yet. Run `bun apps/cli/src/index.ts pull` on this machine, then retry.",
            );
          }
        } catch {
          setDeviceSetupMessage("Couldn't refresh project access.");
        } finally {
          setDeviceSetupInProgress(false);
        }
      })();
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
    setEnvironmentLifecycle("ACTIVE");
    setProjectLifecycle("ACTIVE");
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
          <NavLinks
            onOpenProject={openProject}
            onSetView={openWorkspaceView}
            selectedProjectId={selectedProject?.id ?? null}
            teamProjects={teamProjects}
            view={view}
          />
        </div>
        <div className="mt-auto border-t p-4">
          <div className="flex items-center gap-3">
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
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {displayBoundary.session.displayName ?? "Signed out"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {displayBoundary.session.active
                  ? "Signed in"
                  : "Sign in required"}
              </p>
            </div>
          </div>
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
                  <NavLinks
                    onNavigate={closeMobile}
                    onOpenProject={openProject}
                    onSetView={openWorkspaceView}
                    selectedProjectId={selectedProject?.id ?? null}
                    teamProjects={teamProjects}
                    view={view}
                  />
                </div>
              </SheetContent>
            </Sheet>

            <div className="hidden min-w-0 items-center gap-2 text-sm sm:flex">
              <span className="truncate">{selectedTeam?.name ?? "Team"}</span>
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
              Loading workspace…
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
              {missingResource ? (
                <Alert
                  className="mb-4 border-amber-300/30 bg-amber-300/5"
                  data-testid="workspace-missing-resource"
                >
                  <AlertTitle>
                    {missingResourceCopy[missingResource.kind].title}
                  </AlertTitle>
                  <AlertDescription>
                    {missingResourceCopy[missingResource.kind].description}
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
                </section>
              ) : null}

              {view === "environment" &&
              selectedProject &&
              selectedEnvironment ? (
                <section>
                  <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
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
                        setEnvironmentLifecycle((value) =>
                          value === "ACTIVE" ? "ARCHIVED" : "ACTIVE",
                        )
                      }
                      resource="Environment"
                    />
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
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {membershipState.memberships.map((member) => (
                              <TableRow key={member.membershipId}>
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
                                  colSpan={canAdminister ? 3 : 2}
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
                            setProjectLifecycle((value) =>
                              value === "ACTIVE" ? "ARCHIVED" : "ACTIVE",
                            )
                          }
                          resource="Project"
                        />
                      </CardContent>
                    </Card>
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
                                    {device.current ? "This browser" : "Device"}
                                  </div>
                                  <div className="font-mono text-[10px] text-muted-foreground">
                                    {device.id}
                                  </div>
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
                <section id="recovery">
                  <h1 className="font-heading text-3xl font-semibold">
                    Recovery
                  </h1>
                  <p className="mt-2 max-w-2xl text-muted-foreground">
                    Use a recovery kit to authorize a replacement device when
                    none of your devices are available.
                  </p>
                  <Card className="mt-6">
                    <CardHeader>
                      <CardTitle>Use the CLI</CardTitle>
                      <CardDescription>
                        Recovery runs on your machine. Run it after you've
                        trusted this server.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <CopyableCommand value="dotrelay recover" />
                    </CardContent>
                  </Card>
                </section>
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
    </div>
  );
};
