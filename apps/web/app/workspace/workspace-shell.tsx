"use client";

import {
  createBrowserDeviceStorage,
  createDeviceBootstrap,
  createProjectEpochGrantBootstrap,
  createProtocolTransport,
  type DeviceBootstrap,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { cn } from "@/lib/utils";
import {
  emptyWorkspaceBoundary,
  enrolledDeviceRows,
  fetchWorkspaceBoundary,
  type MembershipRole,
  projectDisplayName,
  type ResourceLifecycle,
  resolveApiOrigin,
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
  WORKSPACE_DEFAULT_PROFILE_ID,
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
    : (environment?.label ?? "an Environment");

const WORKSPACE_REFRESH_MS = Math.max(
  Number(process.env.NEXT_PUBLIC_DOTRELAY_WORKSPACE_REFRESH_MS ?? 0) || 30_000,
  1_000,
);
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

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
  OWNER: "Owners can manage Members, Projects, and Environments.",
  ADMIN:
    "Admins can invite Members and manage Projects and Environments. They cannot change owners or other admins.",
  MEMBER: "Members can view this Team's Projects.",
};

const missingResourceCopy: Readonly<
  Record<
    WorkspaceMissingResource["kind"],
    Readonly<{ title: string; description: string }>
  >
> = {
  team: {
    title: "That Team is no longer available",
    description:
      "It may have been deleted, or you may have lost access. The first Team is shown instead.",
  },
  project: {
    title: "That Project is no longer available",
    description:
      "It may have been archived or deleted, or you may have lost access. Choose a Project to continue.",
  },
  environment: {
    title: "That Environment is no longer available",
    description:
      "It may have been deleted, or you may have lost access. The first available Environment of the Project is shown instead.",
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

// Search strings alone do not identify a history entry: a projects → team →
// projects round trip stores the same string on two entries, and inferring
// the position from the URL then matches the wrong side. Each entry the
// shell writes therefore carries its own bookkeeping index in history.state,
// and Back/Forward reads it back from the popstate event. Next.js copies its
// router state on top of the object (and ignores the extra key), so the two
// stay in step; entries the shell never wrote fall back to URL matching.
const WORKSPACE_ENTRY_INDEX_STATE_KEY = "dotrelayWorkspaceEntryIndex";
const workspaceEntryState = (index: number) => ({
  [WORKSPACE_ENTRY_INDEX_STATE_KEY]: index,
});

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
  window.history.replaceState(
    workspaceEntryState(workspaceHistoryBookkeeping.index),
    "",
    urlForSearch(search),
  );
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
        {isActive ? "Archive" : "Restore"} {resource}
      </DialogTrigger>
      <DialogContent role="alertdialog">
        <DialogHeader>
          <DialogTitle>
            {isActive ? "Archive" : "Restore"} {resource}?
          </DialogTitle>
          <DialogDescription>
            {isActive
              ? resource === "Environment"
                ? "History is kept. Variables stay hidden until you restore it."
                : "Another Project can then use this GitHub repository."
              : resource === "Environment"
                ? "Restoring makes this Environment eligible for protected access again."
                : "Restore fails if another active Project already uses this GitHub repository."}
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

export const WorkspaceShell = ({
  protocolSession,
}: Readonly<{
  readonly protocolSession?: EnvironmentProtocolSession;
}>) => {
  const [role, setRole] = useState<MembershipRole>("OWNER");
  const [profileId, setProfileId] = useState<ProfileId>("hosted");
  const [boundary, setBoundary] = useState<WorkspaceBoundary>(() =>
    emptyWorkspaceBoundary("hosted"),
  );
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [verifiedAt, setVerifiedAt] = useState<number | null>(null);
  const reconnectNowRef = useRef<(() => void) | null>(null);
  const boundaryJsonRef = useRef(
    JSON.stringify(emptyWorkspaceBoundary("hosted")),
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
  const [githubSubject, setGithubSubject] = useState("");
  const [invitations, setInvitations] = useState<string[]>([]);
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
  const [trustedOverride, setTrustedOverride] = useState(false);
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

  const protectedPreview = preview === "protected";
  const noCryptoPreview = preview === "no-crypto";

  const displayBoundary = useMemo(() => {
    const cryptoAvailable =
      !noCryptoPreview &&
      browserCrypto &&
      (protectedPreview || boundary.crypto.available);
    return {
      ...boundary,
      profile: {
        ...boundary.profile,
        pinned: trustedOverride || boundary.profile.pinned || protectedPreview,
      },
      device: protectedPreview
        ? { active: true, label: "Active Device" }
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
  }, [
    boundary,
    browserCrypto,
    noCryptoPreview,
    protectedPreview,
    trustedOverride,
  ]);

  const teams = displayBoundary.catalog.teams;
  const selectedTeam =
    teams.find((team) => team.id === teamId) ?? teams[0] ?? null;
  const teamProjects = displayBoundary.catalog.projects.filter(
    (project) => project.teamId === selectedTeam?.id,
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
  const thisBrowserEnrolled =
    protectedPreview ||
    Boolean(protocolSession) ||
    (currentPinKey !== null &&
      durableBrowserDeviceRef.current.has(currentPinKey));
  const enrolledDevices = enrolledDeviceRows(displayBoundary, {
    thisBrowserEnrolled,
  });

  const setupAction = nextSetupAction({
    sessionActive: displayBoundary.session.active,
    profileTrusted: displayBoundary.profile.pinned,
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
      setMissingResource(location.missing ?? null);
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
      window.history.pushState(
        workspaceEntryState(workspaceHistoryBookkeeping.index),
        "",
        urlForSearch(search),
      );
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
            : (selectedTeam?.name ?? "this Team"),
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
  // the reconciliation effect once the boundary loads.
  useEffect(() => {
    setBrowserCrypto(
      typeof globalThis.crypto?.subtle?.importKey === "function",
    );
    const params = new URLSearchParams(window.location.search);
    const nextPreview = params.get("preview");
    setPreview(nextPreview);
    const parsed = parseWorkspaceLocation(params);
    if (parsed.profileId !== WORKSPACE_DEFAULT_PROFILE_ID) {
      setProfileId(parsed.profileId);
      const placeholder = emptyWorkspaceBoundary(parsed.profileId);
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
        profileId: parsed.profileId,
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
        // Commit through applySelection so the same-location path refreshes
        // resource lifecycle and normalizes the URL entry (a reload of a
        // shared link lands here).
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
  const handlePopState = (state: unknown) => {
    // A Back/Forward that leaves the workspace page navigates away from it;
    // only entries under /workspace are owned by this shell.
    if (window.location.pathname !== "/workspace") return;
    const fromIndex = workspaceHistoryBookkeeping.index;
    const entries = workspaceHistoryBookkeeping.entries;
    const search = window.location.search.replace(/^\?/, "");
    // Entries the shell wrote carry their own index in history.state, which
    // identifies them even when another entry repeats their search string
    // (a projects → team → projects round trip). Anything else is an entry
    // the app never wrote, which can only sit below the first entry the
    // shell committed, so fall back to matching the adjacent entries first.
    const stored = state as Readonly<Record<string, unknown>> | null;
    const storedIndex = stored?.[WORKSPACE_ENTRY_INDEX_STATE_KEY];
    let toIndex: number;
    if (
      typeof storedIndex === "number" &&
      storedIndex >= 0 &&
      storedIndex < entries.length
    ) {
      toIndex = storedIndex;
    } else if (fromIndex > 0 && entries[fromIndex - 1] === search) {
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
    const target =
      teams.length > 0 || connection === "online"
        ? resolveWorkspaceLocation(
            parsed,
            displayBoundary.catalog,
            viewFallback,
          )
        : {
            profileId: parsed.profileId,
            teamId: parsed.teamId,
            projectId: parsed.projectId,
            environmentId: parsed.environmentId,
            view: parsed.view ?? viewFallback(parsed.projectId !== null),
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
    const listener = (event: PopStateEvent) =>
      handlePopStateRef.current(event.state);
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
      setDeviceSetupMessage("Sign in before enrolling a Device.");
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
          "This browser can't use persistent storage (IndexedDB), so Device keys would not survive a reload. No Device was created.",
        );
        return;
      }
      if (!probeBrowserLocalStorage()) {
        setDeviceSetupMessage(
          "This browser blocks local storage, so the Device id would not survive a reload. No Device was created.",
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
          throw new Error("Sign in before enrolling a Device.");
        if (body?.code === "state_conflict")
          throw new Error("This Device could not be enrolled. Try again.");
        throw new Error("the Server Profile rejected this Device");
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
              "This browser is enrolled. Project access is still pending.",
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
            : "This browser is enrolled. Keys stay on this machine.",
        );
      } else if (persistence === "records") {
        setDeviceSetupMessage(
          "This Device was created, but this browser could not keep its keys durably, so it will not survive a reload. Retry enrollment to save them again.",
        );
      } else {
        setDeviceSetupMessage(
          "This Device was created, but this browser cannot remember its Device id, so it will not survive a reload. Retry enrollment to store it again.",
        );
      }
    } catch (error) {
      setDeviceSetupMessage(
        error instanceof Error
          ? error.message
          : "Device enrollment could not be completed.",
      );
    } finally {
      setDeviceSetupInProgress(false);
    }
  };

  const handleSetupAction = () => {
    if (!editorSetupAction) return;
    if (editorSetupAction.id === "trust-profile") {
      setTrustedOverride(true);
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
            setDeviceSetupMessage("Could not refresh Project access.");
          } else {
            commitBoundary(nextBoundary);
            setDeviceSetupMessage(
              nextBoundary.grantsReady
                ? null
                : "Project keys are not on this browser yet. Run bun apps/cli/src/index.ts pull, then retry.",
            );
          }
        } catch {
          setDeviceSetupMessage("Could not refresh Project access.");
        } finally {
          setDeviceSetupInProgress(false);
        }
      })();
      return;
    }
    if (editorSetupAction.id === "crypto-unavailable") {
      void copyText(cliCommand).then(() =>
        setDeviceSetupMessage("Copied the CLI command."),
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
    setInvitations([]);
    setEnvironmentLifecycle("ACTIVE");
    setProjectLifecycle("ACTIVE");
    setInvitationOpen(false);
    setGithubSubject("");
    setTrustedOverride(false);
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

  const createInvitation = () => {
    const subject = githubSubject.trim();
    if (!subject) return;
    setInvitations((current) => [...current, subject]);
    setGithubSubject("");
    setInvitationOpen(false);
  };

  const closeMobile = () => setMobileOpen(false);

  const NavLinks = ({ onNavigate }: { readonly onNavigate?: () => void }) => (
    <nav aria-label="Workspace navigation" className="grid gap-1">
      <button
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
          view === "projects" || view === "environment"
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-muted-foreground",
        )}
        onClick={() => {
          openWorkspaceView("projects");
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
            selectedProject?.id === project.id && view === "environment"
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground",
          )}
          key={project.id}
          onClick={() => {
            openProject(project);
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
          openWorkspaceView("team");
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
          openWorkspaceView("devices");
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
          openWorkspaceView("recovery");
          onNavigate?.();
        }}
        type="button"
      >
        <KeyRound aria-hidden="true" className="size-4" />
        Recovery
      </button>
    </nav>
  );

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
        <div className="space-y-3 p-3">
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
                  {team.name}
                </option>
              ))}
            </select>
          </div>
          <NavLinks />
        </div>
        <div className="mt-auto border-t p-4">
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
                <div className="space-y-3 p-3">
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
                        {team.name}
                      </option>
                    ))}
                  </select>
                  <NavLinks onNavigate={closeMobile} />
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

            <div className="ml-auto flex items-center gap-2">
              <Label className="sr-only" htmlFor="server-profile">
                Server Profile
              </Label>
              <select
                aria-label="Server Profile"
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
                <AlertTitle>Couldn't reach your Server Profile</AlertTitle>
                <AlertDescription>
                  The workspace request failed, so this page shows no identity,
                  Teams, or Projects until the connection is verified. We keep
                  trying automatically, or try again now.
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
                      Connection lost — showing stale data
                    </AlertTitle>
                    <AlertDescription>
                      Last verified at{" "}
                      {new Date(verifiedAt).toLocaleTimeString()}. We keep
                      trying to reconnect, or try again now.
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
              {view === "projects" ? (
                <section>
                  <div className="mb-6">
                    <p className="text-sm text-muted-foreground">Team</p>
                    <h1 className="font-heading text-3xl font-semibold tracking-tight">
                      {selectedTeam?.name ?? "Choose a Team"}
                    </h1>
                    <p className="mt-2 max-w-2xl text-muted-foreground">
                      Pick a Project to view its Environments and Variables. Use
                      the Team menu to switch.
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
                        <CardTitle>No Projects yet</CardTitle>
                        <CardDescription>
                          Link a GitHub repository from the CLI with{" "}
                          <code>dotrelay init</code>.
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
                              .join(", ") || "No Environments"}
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
                          aria-label="Preview Membership role"
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
                    <AlertTitle>{effectiveRole} Membership</AlertTitle>
                    <AlertDescription>
                      {roleDisclosure[effectiveRole]}
                    </AlertDescription>
                  </Alert>
                  <Card>
                    <CardHeader>
                      <CardTitle>Members</CardTitle>
                      <CardDescription>
                        Invitations go to a GitHub user id and expire after
                        seven days.
                      </CardDescription>
                      <CardAction>
                        <Button
                          disabled={!canAdminister}
                          onClick={() => setInvitationOpen(true)}
                        >
                          <Users aria-hidden="true" /> Invite member
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>User</TableHead>
                            <TableHead>Role</TableHead>
                            <TableHead>Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <TableRow>
                            <TableCell>
                              <div className="font-medium">
                                {displayBoundary.session.displayName ?? "You"}
                              </div>
                            </TableCell>
                            <TableCell>
                              {effectiveRole === "OWNER"
                                ? "Owner"
                                : effectiveRole === "ADMIN"
                                  ? "Admin"
                                  : "Member"}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">Active</Badge>
                            </TableCell>
                          </TableRow>
                          {invitations.map((subject) => (
                            <TableRow key={subject}>
                              <TableCell>
                                <div className="font-medium">
                                  Invitation sent
                                </div>
                                <div className="font-mono text-[10px] text-muted-foreground">
                                  {subject}
                                </div>
                              </TableCell>
                              <TableCell>Member</TableCell>
                              <TableCell>
                                <Badge
                                  className="border-amber-300/25 text-amber-200"
                                  variant="outline"
                                >
                                  Pending key grant
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                  {selectedProject ? (
                    <Card className="mt-4">
                      <CardHeader>
                        <CardTitle>
                          {projectDisplayName(selectedProject)}
                        </CardTitle>
                        <CardDescription>
                          Archive the Project if this repository should be free
                          for another active Project.
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
                    A Device is this browser, or the CLI on a machine. Signing
                    in is not enough to read variables.
                  </p>
                  {enrolledDevices.length > 0 ? (
                    <Card className="mt-6">
                      <CardHeader>
                        <CardTitle>Enrolled Devices</CardTitle>
                        <CardDescription>
                          Active Devices that can decrypt variables for your
                          User.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Table aria-label="Enrolled Devices">
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
                                    {device.current
                                      ? "This browser"
                                      : "Enrolled Device"}
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
                                      ? "Has Project access"
                                      : "Pending Project access"}
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
                          ? "This browser is enrolled"
                          : "Enroll this browser"}
                      </CardTitle>
                      <CardDescription>
                        {thisBrowserEnrolled
                          ? "This Device can decrypt variables for your User."
                          : "Create a key pair in this browser. The CLI on this machine is a separate Device."}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Prefer the CLI? That enrolls the CLI, not this browser.
                      </p>
                      <CopyableCommand
                        data-testid="cli-setup-command"
                        value={cliCommand}
                      />
                      {deviceSetupMessage ? (
                        <p className="mt-3 text-sm text-muted-foreground">
                          {deviceSetupMessage}
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
                            ? "Enrolling…"
                            : "Enroll browser"}
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
                    A Recovery Kit can authorize a replacement Device when none
                    of yours are available.
                  </p>
                  <Card className="mt-6">
                    <CardHeader>
                      <CardTitle>Use the CLI</CardTitle>
                      <CardDescription>
                        Recovery runs locally after you trust this Server
                        Profile.
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

      <Dialog onOpenChange={setInvitationOpen} open={invitationOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a Member</DialogTitle>
            <DialogDescription>
              Address this single-use, seven-day invitation to a GitHub user id,
              not an email.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="github-subject">GitHub subject</Label>
            <Input
              autoComplete="off"
              id="github-subject"
              onChange={(event) => setGithubSubject(event.target.value)}
              placeholder="github:18473192"
              value={githubSubject}
            />
          </div>
          <Alert className="bg-muted/30">
            <AlertTitle>Pending after acceptance</AlertTitle>
            <AlertDescription>
              They stay pending until the required key grants are in place.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={!githubSubject.trim()} onClick={createInvitation}>
              Create invitation
            </Button>
          </DialogFooter>
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
              {switchRebinding
                ? "Switch Server Profile?"
                : "Keep unsaved changes?"}
            </DialogTitle>
            <DialogDescription>
              {pendingSwitch
                ? switchRebinding
                  ? `You have unsaved changes in ${
                      pendingSwitch.details.length === 1
                        ? pendingSwitch.details[0]
                        : `${pendingSwitch.details.length} Environments in ${pendingSwitch.leavingLabel}`
                    }. Switching to ${pendingSwitch.targetLabel ?? "another Server Profile"} discards them and cancels any in-flight operations.`
                  : `You have unsaved changes in ${pendingSwitch.leavingLabel}${pendingSwitch.details.length > 0 ? ` (${pendingSwitch.details.join(", ")})` : ""}. Keep them to find the draft again when you return, or discard them. Discarding throws away those changes and cancels any in-flight operations for this Environment.`
                : "You have unsaved changes in the current Environment."}
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
    </div>
  );
};
