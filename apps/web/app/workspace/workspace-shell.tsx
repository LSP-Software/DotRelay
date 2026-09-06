"use client";

import {
  createBrowserDeviceStorage,
  createDeviceBootstrap,
  createProjectEpochGrantBootstrap,
  createProtocolTransport,
  loadDeviceKeyMaterial,
  openProjectEpochGrant,
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
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CopyableCommand } from "@/components/copyable-command";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  createEnvironmentProtocolSession,
  type EnvironmentProtocolSession,
} from "@/lib/environment-protocol-session";
import {
  displayedSetupAction,
  nextSetupAction,
} from "@/lib/environment-workflow";
import {
  signOutFromServerProfile,
  updateUserName,
} from "@/lib/session-actions";
import { cn } from "@/lib/utils";
import {
  e2eWorkspaceBoundary,
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
import { EnvironmentEditor } from "./environment-editor";
import { UserSessionCard } from "./user-session-card";

type ProfileId = WorkspaceProfileId;
type WorkspaceView =
  | "projects"
  | "environment"
  | "team"
  | "devices"
  | "recovery"
  | "settings";

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

const browserDeviceIdKey = (origin: string, serverProfileId: string): string =>
  `dotrelay.browser-device:${origin}:${serverProfileId}`;

const readStoredBrowserDeviceId = (
  origin: string,
  serverProfileId: string,
): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(
      browserDeviceIdKey(origin, serverProfileId),
    );
  } catch {
    return null;
  }
};

const writeStoredBrowserDeviceId = (
  origin: string,
  serverProfileId: string,
  deviceId: string,
) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      browserDeviceIdKey(origin, serverProfileId),
      deviceId,
    );
  } catch {
    return;
  }
};

const roleDisclosure: Readonly<Record<MembershipRole, string>> = {
  OWNER: "Owners can manage Members, Projects, and Environments.",
  ADMIN:
    "Admins can invite Members and manage Projects and Environments. They cannot change owners or other admins.",
  MEMBER: "Members can view this Team's Projects.",
};

const writeWorkspaceParams = (input: {
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
}) => {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const assign = (key: string, value: string | null) => {
    if (value) params.set(key, value);
    else params.delete(key);
  };
  assign("team", input.teamId);
  assign("project", input.projectId);
  assign("environment", input.environmentId);
  const next = params.toString();
  window.history.replaceState(
    null,
    "",
    next ? `${window.location.pathname}?${next}` : window.location.pathname,
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
    e2eWorkspaceBoundary("hosted"),
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
  const [liveProtocolSession, setLiveProtocolSession] =
    useState<EnvironmentProtocolSession | null>(null);
  const [deviceSetupMessage, setDeviceSetupMessage] = useState<string | null>(
    null,
  );
  const [deviceSetupInProgress, setDeviceSetupInProgress] = useState(false);
  const [trustedOverride, setTrustedOverride] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [browserCrypto, setBrowserCrypto] = useState(true);
  const [displayNameOverride, setDisplayNameOverride] = useState<string | null>(
    null,
  );
  const [nameDraft, setNameDraft] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);

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
  const sessionDisplayName =
    displayNameOverride ?? displayBoundary.session.displayName;
  const apiOrigin = resolveApiOrigin() ?? displayBoundary.profile.origin;
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
  const effectiveRole =
    displayBoundary.source === "fixture" || preview === "admin"
      ? role
      : (selectedTeam?.role ?? "MEMBER");
  const canAdminister = effectiveRole === "OWNER" || effectiveRole === "ADMIN";
  const cliCommand = `dotrelay setup ${displayBoundary.profile.origin}`;
  const thisBrowserEnrolled =
    protectedPreview || Boolean(liveProtocolSession ?? protocolSession);

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
    !liveProtocolSession;
  const protectedWorkflowAvailable =
    setupAction === null && !localDeviceBlockers;
  const cliSetupCommand =
    setupAction?.id === "crypto-unavailable" ? cliCommand : undefined;
  const editorSetupAction = displayedSetupAction(setupAction, {
    localDeviceBlockers,
    inProgress: deviceSetupInProgress,
  });

  const syncSelection = (next: {
    readonly teamId: string | null;
    readonly projectId: string | null;
    readonly environmentId: string | null;
    readonly view?: WorkspaceView;
  }) => {
    setTeamId(next.teamId);
    setProjectId(next.projectId);
    setEnvironmentId(next.environmentId);
    if (next.view) setView(next.view);
    writeWorkspaceParams(next);
  };

  const openProject = (project: WorkspaceProject) => {
    const firstEnvironment = project.environments[0];
    syncSelection({
      teamId: project.teamId,
      projectId: project.id,
      environmentId: firstEnvironment?.id ?? null,
      view: "environment",
    });
    setProjectLifecycle(project.lifecycle);
    setEnvironmentLifecycle(firstEnvironment?.lifecycle ?? "ACTIVE");
  };

  useEffect(() => {
    setBrowserCrypto(
      typeof globalThis.crypto?.subtle?.importKey === "function",
    );
    const params = new URLSearchParams(window.location.search);
    const nextPreview = params.get("preview");
    setPreview(nextPreview);
    setTeamId(params.get("team"));
    setProjectId(params.get("project"));
    setEnvironmentId(params.get("environment"));
    if (nextPreview === "protected" || params.get("project"))
      setView("environment");
  }, []);

  useEffect(() => {
    if (teams.length === 0) return;
    const firstTeam = teams.find((team) => team.id === teamId) ?? teams[0];
    if (!firstTeam) return;
    const firstProject = displayBoundary.catalog.projects.find(
      (project) => project.teamId === firstTeam.id,
    );
    const firstEnvironment = firstProject?.environments[0];
    if (preview === "protected" && !projectId && firstProject) {
      syncSelection({
        teamId: firstTeam.id,
        projectId: firstProject.id,
        environmentId: firstEnvironment?.id ?? null,
        view: "environment",
      });
      return;
    }
    if (!teamId) setTeamId(firstTeam.id);
  }, [displayBoundary.catalog.projects, preview, projectId, teamId, teams]);

  useEffect(() => {
    let cancelled = false;
    const loadBoundary = async () => {
      try {
        const nextBoundary = await fetchWorkspaceBoundary(profileId, {
          ...(environmentId ? { environmentId } : {}),
        });
        const serverProfileId = nextBoundary.profile.serverProfileId;
        const storedId = serverProfileId
          ? readStoredBrowserDeviceId(
              nextBoundary.profile.origin,
              serverProfileId,
            )
          : null;
        const resolved =
          storedId && storedId !== nextBoundary.device.id
            ? await fetchWorkspaceBoundary(profileId, {
                deviceId: storedId,
                ...(environmentId ? { environmentId } : {}),
              })
            : nextBoundary;
        if (!cancelled) {
          setBoundary(resolved);
          if (!storedId) setLiveProtocolSession(null);
        }
      } catch {
        if (!cancelled) setBoundary(e2eWorkspaceBoundary(profileId));
      }
    };
    void loadBoundary();
    return () => {
      cancelled = true;
    };
  }, [profileId, environmentId]);

  useEffect(() => {
    let cancelled = false;
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
        if (!cancelled) setLiveProtocolSession(null);
        return;
      }
      try {
        const pin = {
          serverProfileId: profile.serverProfileId,
          origin: profile.origin,
        };
        const storage = createBrowserDeviceStorage(pin);
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
          ...(expectedHeadId ? {} : { mutation: "GENESIS" as const }),
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
        if (!cancelled) setLiveProtocolSession(session);
      } catch {
        if (!cancelled) setLiveProtocolSession(null);
      }
    };
    void loadSession();
    return () => {
      cancelled = true;
    };
  }, [boundary]);

  const provisionBrowserDevice = async () => {
    const apiOrigin = resolveApiOrigin() ?? boundary.profile.origin;
    if (!boundary.session.userId || !boundary.profile.serverProfileId) {
      setDeviceSetupMessage("Sign in before enrolling a Device.");
      return;
    }
    setDeviceSetupInProgress(true);
    setDeviceSetupMessage(null);
    try {
      const pin = {
        serverProfileId: boundary.profile.serverProfileId,
        origin: boundary.profile.origin,
      };
      const bootstrap = await createDeviceBootstrap({
        pin,
        userId: boundary.session.userId,
      });
      const response = await fetch(`${apiOrigin}/api/v1/devices/bootstrap`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: globalThis.crypto.randomUUID(),
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
          throw new Error(
            "This Device could not be enrolled. Refresh and try again.",
          );
        throw new Error("the Server Profile rejected this Device");
      }
      await createBrowserDeviceStorage(pin).save(bootstrap.bundle);
      writeStoredBrowserDeviceId(
        pin.origin,
        pin.serverProfileId,
        bootstrap.deviceId,
      );
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
      const nextBoundary = await fetchWorkspaceBoundary(profileId, {
        deviceId: bootstrap.deviceId,
        ...(selectedEnvironment?.id
          ? { environmentId: selectedEnvironment.id }
          : environmentId
            ? { environmentId }
            : {}),
      });
      setBoundary(nextBoundary);
      setDeviceSetupMessage((current) =>
        current?.includes("pending")
          ? current
          : "This browser is enrolled. Keys stay on this machine.",
      );
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
          setBoundary(nextBoundary);
          setDeviceSetupMessage(
            nextBoundary.grantsReady
              ? null
              : "Project keys are not on this browser yet. Run bun apps/cli/src/index.ts pull, then retry.",
          );
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
      void fetchWorkspaceBoundary(profileId).then(setBoundary);
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

  const handleProfileChange = (nextProfileId: ProfileId) => {
    resetWorkspaceContext();
    setProfileId(nextProfileId);
    setBoundary(e2eWorkspaceBoundary(nextProfileId));
  };

  const handleTeamChange = (nextTeamId: string) => {
    syncSelection({
      teamId: nextTeamId,
      projectId: null,
      environmentId: null,
      view: "projects",
    });
    setProjectLifecycle("ACTIVE");
    setEnvironmentLifecycle("ACTIVE");
  };

  const createInvitation = () => {
    const subject = githubSubject.trim();
    if (!subject) return;
    setInvitations((current) => [...current, subject]);
    setGithubSubject("");
    setInvitationOpen(false);
  };

  const closeMobile = () => setMobileOpen(false);

  const openSettings = () => {
    setNameDraft(sessionDisplayName ?? "");
    setSettingsMessage(null);
    setView("settings");
  };

  const handleSignOut = () => {
    const finish = () => {
      window.location.assign("/sign-in");
    };
    if (displayBoundary.source !== "live") {
      finish();
      return;
    }
    void signOutFromServerProfile(apiOrigin).finally(finish);
  };

  const handleSignIn = () => {
    window.location.assign("/sign-in");
  };

  const handleSaveName = async () => {
    const nextName = nameDraft.trim();
    if (!nextName) return;
    setSettingsBusy(true);
    setSettingsMessage(null);
    try {
      if (displayBoundary.source === "live") {
        const saved = await updateUserName(apiOrigin, nextName);
        if (!saved) {
          setSettingsMessage("Your name could not be saved.");
          return;
        }
      }
      setDisplayNameOverride(nextName);
      setSettingsMessage("Name saved.");
    } catch {
      setSettingsMessage("Your name could not be saved.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const sessionCardProps = {
    ...(sessionDisplayName ? { displayName: sessionDisplayName } : {}),
    onOpenSettings: () => {
      openSettings();
      closeMobile();
    },
    onSignIn: handleSignIn,
    onSignOut: handleSignOut,
    sessionActive: displayBoundary.session.active,
  } as const;

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
          setView("projects");
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
          setView("team");
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
          setView("devices");
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
          setView("recovery");
          onNavigate?.();
        }}
        type="button"
      >
        <KeyRound aria-hidden="true" className="size-4" />
        Recovery
      </button>
    </nav>
  );

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
          <UserSessionCard {...sessionCardProps} />
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
                <div className="mt-auto border-t p-4">
                  <UserSessionCard {...sessionCardProps} />
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
                  handleProfileChange(event.target.value as ProfileId)
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
          {view === "projects" ? (
            <section>
              <div className="mb-6">
                <p className="text-sm text-muted-foreground">Team</p>
                <h1 className="font-heading text-3xl font-semibold tracking-tight">
                  {selectedTeam?.name ?? "Choose a Team"}
                </h1>
                <p className="mt-2 max-w-2xl text-muted-foreground">
                  Pick a Project to view its Environments and Variables. Use the
                  Team menu to switch.
                </p>
              </div>
              {setupAction &&
              (setupAction.id === "sign-in" ||
                setupAction.id === "trust-profile" ||
                setupAction.id === "crypto-unavailable") ? (
                <div className="mb-6">
                  <EnvironmentEditor
                    available={false}
                    onSetupAction={handleSetupAction}
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
                      <p className="text-xs text-muted-foreground">Project</p>
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

          {view === "environment" && selectedProject && selectedEnvironment ? (
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
                  syncSelection({
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
                    <TabsTrigger key={environment.id} value={environment.id}>
                      {environment.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <EnvironmentEditor
                available={protectedWorkflowAvailable}
                onSetupAction={handleSetupAction}
                setupAction={editorSetupAction}
                setupBusy={deviceSetupInProgress}
                setupCommand={cliSetupCommand}
                setupMessage={deviceSetupMessage}
                {...((liveProtocolSession ?? protocolSession)
                  ? { protocolSession: liveProtocolSession ?? protocolSession }
                  : {})}
              />
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
                {displayBoundary.source === "fixture" || preview === "admin" ? (
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
                    Invitations go to a GitHub user id and expire after seven
                    days.
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
                            {sessionDisplayName ?? "You"}
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
                            <div className="font-medium">Invitation sent</div>
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
                    <CardTitle>{projectDisplayName(selectedProject)}</CardTitle>
                    <CardDescription>
                      Archive the Project if this repository should be free for
                      another active Project.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between gap-4">
                    <Badge
                      data-testid="project-lifecycle"
                      variant={
                        projectLifecycle === "ACTIVE" ? "default" : "secondary"
                      }
                    >
                      {projectLifecycle === "ACTIVE" ? "Active" : "Archived"}
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
              <h1 className="font-heading text-3xl font-semibold">Devices</h1>
              <p className="mt-2 max-w-2xl text-muted-foreground">
                A Device is this browser, or the CLI on a machine. Signing in is
                not enough to read variables.
              </p>
              <Card className="mt-6">
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
                      {deviceSetupInProgress ? "Enrolling…" : "Enroll browser"}
                    </Button>
                  </CardFooter>
                ) : null}
              </Card>
            </section>
          ) : null}

          {view === "recovery" ? (
            <section id="recovery">
              <h1 className="font-heading text-3xl font-semibold">Recovery</h1>
              <p className="mt-2 max-w-2xl text-muted-foreground">
                A Recovery Kit can authorize a replacement Device when none of
                yours are available.
              </p>
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle>Use the CLI</CardTitle>
                  <CardDescription>
                    Recovery runs locally after you trust this Server Profile.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CopyableCommand value="dotrelay recover" />
                </CardContent>
              </Card>
            </section>
          ) : null}

          {view === "settings" ? (
            <section id="settings">
              <h1 className="font-heading text-3xl font-semibold">Settings</h1>
              <p className="mt-2 max-w-2xl text-muted-foreground">
                Your name is shown to Members of your Teams.
              </p>
              <Card className="mt-6">
                <CardHeader>
                  <CardTitle>Name</CardTitle>
                  <CardDescription>
                    This is the name other Members see for your User.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    className="space-y-2"
                    id="settings-name-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleSaveName();
                    }}
                  >
                    <Label htmlFor="user-name">Name</Label>
                    <Input
                      autoComplete="name"
                      id="user-name"
                      maxLength={255}
                      onChange={(event) => setNameDraft(event.target.value)}
                      value={nameDraft}
                    />
                    {settingsMessage ? (
                      <p
                        className="text-sm text-muted-foreground"
                        role="status"
                      >
                        {settingsMessage}
                      </p>
                    ) : null}
                  </form>
                </CardContent>
                <CardFooter>
                  <Button
                    disabled={settingsBusy || nameDraft.trim().length === 0}
                    form="settings-name-form"
                    type="submit"
                  >
                    {settingsBusy ? "Saving…" : "Save name"}
                  </Button>
                </CardFooter>
              </Card>
            </section>
          ) : null}
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
    </div>
  );
};
