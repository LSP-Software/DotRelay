"use client";

import {
  Archive,
  Braces,
  ChevronRight,
  CircleUserRound,
  Clock3,
  GitBranch,
  History,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  MonitorSmartphone,
  RefreshCcw,
  RotateCcw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
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
import { Separator } from "@/components/ui/separator";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  e2eWorkspaceBoundary,
  fetchWorkspaceBoundary,
  type WorkspaceBoundary,
  type WorkspaceProfileId,
  workspaceProfileCatalog,
} from "@/lib/workspace-boundary";

type MembershipRole = "OWNER" | "ADMIN" | "MEMBER";
type ResourceLifecycle = "ACTIVE" | "ARCHIVED";
type ProfileId = WorkspaceProfileId;

const roleDisclosure: Readonly<Record<MembershipRole, string>> = {
  OWNER: "Owners can administer Members, roles, Projects, and Environments.",
  ADMIN:
    "Admins can invite Members and administer Projects and Environments, but not owners or admins.",
  MEMBER: "Members can view active Team content only.",
};

const navigation = [
  { label: "Overview", href: "#overview", icon: LayoutDashboard },
  { label: "Revision history", href: "#revisions", icon: History },
  { label: "Administration", href: "#administration", icon: Users },
  { label: "Devices", href: "#devices", icon: MonitorSmartphone },
  { label: "Recovery", href: "#recovery", icon: KeyRound },
] as const;

const NavLinks = ({ onNavigate }: { readonly onNavigate?: () => void }) => (
  <nav aria-label="Workspace navigation" className="grid gap-1">
    {navigation.map((item) => (
      <a
        className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
        href={item.href}
        key={item.href}
        onClick={onNavigate}
      >
        <item.icon aria-hidden="true" className="size-4" />
        {item.label}
      </a>
    ))}
  </nav>
);

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
                ? "Encrypted history is retained, but Manifest lanes will not be disclosed."
                : "The GitHub Repository linkage becomes available to another active Project."
              : resource === "Environment"
                ? "Restoring makes this Environment eligible for protected access again."
                : "Restore fails closed if another active Project uses the same stable GitHub repository id."}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
          {resource.toLowerCase()} lifecycle: {lifecycle.toLowerCase()} →{" "}
          {isActive ? "archived" : "active"}
        </div>
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

const StatusItem = ({
  icon: Icon,
  label,
  detail,
  tone,
}: {
  readonly icon: typeof ShieldCheck;
  readonly label: string;
  readonly detail: string;
  readonly tone: "ok" | "warn";
}) => (
  <div className="flex min-w-0 items-start gap-3 rounded-lg border bg-background/45 p-3">
    <Icon
      aria-hidden="true"
      className={cn(
        "mt-0.5 size-4 shrink-0",
        tone === "ok" ? "text-primary" : "text-amber-300",
      )}
    />
    <div className="min-w-0">
      <p className="text-sm font-medium">{label}</p>
      <p className="truncate font-mono text-[10px] text-muted-foreground">
        {detail}
      </p>
    </div>
  </div>
);

export const WorkspaceShell = () => {
  const [role, setRole] = useState<MembershipRole>("OWNER");
  const [profileId, setProfileId] = useState<ProfileId>("hosted");
  const [boundary, setBoundary] = useState<WorkspaceBoundary>(() =>
    e2eWorkspaceBoundary("hosted"),
  );
  const [environmentLifecycle, setEnvironmentLifecycle] =
    useState<ResourceLifecycle>("ACTIVE");
  const [projectLifecycle, setProjectLifecycle] =
    useState<ResourceLifecycle>("ACTIVE");
  const [invitationOpen, setInvitationOpen] = useState(false);
  const [githubSubject, setGithubSubject] = useState("");
  const [invitations, setInvitations] = useState<string[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const profile = boundary.profile;
  const canAdminister = role === "OWNER" || role === "ADMIN";

  useEffect(() => {
    let cancelled = false;
    fetchWorkspaceBoundary(profileId)
      .then((nextBoundary) => {
        if (!cancelled) setBoundary(nextBoundary);
      })
      .catch(() => {
        if (!cancelled) setBoundary(e2eWorkspaceBoundary(profileId));
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const resetWorkspaceContext = () => {
    setInvitations([]);
    setEnvironmentLifecycle("ACTIVE");
    setProjectLifecycle("ACTIVE");
    setInvitationOpen(false);
    setGithubSubject("");
  };

  const handleProfileChange = (nextProfileId: ProfileId) => {
    resetWorkspaceContext();
    setProfileId(nextProfileId);
    setBoundary(e2eWorkspaceBoundary(nextProfileId));
  };

  const createInvitation = () => {
    const subject = githubSubject.trim();
    if (!subject) return;
    setInvitations((current) => [...current, subject]);
    setGithubSubject("");
    setInvitationOpen(false);
  };

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
          <Badge className="ml-auto font-mono text-[9px]" variant="outline">
            V3
          </Badge>
        </div>
        <div className="p-3">
          <p className="mb-2 px-3 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            Workspace
          </p>
          <NavLinks />
        </div>
        <div className="mt-auto border-t p-4">
          <div className="flex items-center gap-3">
            <Avatar size="sm">
              <AvatarFallback>
                {(boundary.session.displayName ?? "DR")
                  .slice(0, 2)
                  .toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {boundary.session.displayName ?? "Signed out"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {boundary.session.active ? "Signed in" : "Sign in required"}
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
                <div className="p-3">
                  <NavLinks onNavigate={() => setMobileOpen(false)} />
                </div>
              </SheetContent>
            </Sheet>

            <div className="hidden items-center gap-2 text-sm sm:flex">
              <span className="text-muted-foreground">LSP Software</span>
              <ChevronRight
                aria-hidden="true"
                className="size-3 text-muted-foreground"
              />
              <span className="text-muted-foreground">DotRelay</span>
              <ChevronRight
                aria-hidden="true"
                className="size-3 text-muted-foreground"
              />
              <span>production</span>
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
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Profile settings"
                      size="icon"
                      variant="outline"
                    />
                  }
                >
                  <Settings2 aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>Profile settings</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </header>

        <main
          className="mx-auto max-w-[1500px] p-4 sm:p-6"
          id="workspace-content"
          tabIndex={-1}
        >
          <section className="scroll-mt-24" id="overview">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Badge
                    className="border-primary/25 bg-primary/10 text-primary"
                    variant="outline"
                  >
                    Team
                  </Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    TEAM_01HV7Q
                  </span>
                </div>
                <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
                  production
                </h1>
                <p className="mt-2 max-w-2xl text-muted-foreground">
                  LSP Software / DotRelay · current Environment head and
                  non-secret administration.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  className="inline-flex h-9 items-center gap-2 rounded-lg border bg-input/30 px-3 text-sm font-medium hover:bg-input/50"
                  href="#devices"
                >
                  <MonitorSmartphone aria-hidden="true" className="size-4" />{" "}
                  Manage Devices
                </Link>
                <Link
                  className="inline-flex h-9 items-center gap-2 rounded-lg border bg-input/30 px-3 text-sm font-medium hover:bg-input/50"
                  href="#recovery"
                >
                  <KeyRound aria-hidden="true" className="size-4" /> Open
                  recovery
                </Link>
              </div>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-3">
              <StatusItem
                detail={profile.origin}
                icon={profile.pinned ? ShieldCheck : ShieldAlert}
                label={
                  profile.pinned
                    ? "Profile pinned"
                    : "Trust confirmation required"
                }
                tone={profile.pinned ? "ok" : "warn"}
              />
              <StatusItem
                detail={
                  boundary.session.active
                    ? "cookie · server-local User"
                    : "sign in to continue"
                }
                icon={CircleUserRound}
                label={
                  boundary.session.active ? "Session active" : "No session"
                }
                tone={boundary.session.active ? "ok" : "warn"}
              />
              <StatusItem
                detail={
                  boundary.device.active
                    ? "authorized for protected operations"
                    : "protected operations blocked"
                }
                icon={MonitorSmartphone}
                label={
                  boundary.device.active
                    ? "Active Device"
                    : (boundary.device.label ?? "No active Device")
                }
                tone={boundary.device.active ? "ok" : "warn"}
              />
            </div>

            {!boundary.crypto.available ? (
              <Alert className="mt-5 border-amber-300/25 bg-amber-300/5 py-4">
                <LockKeyhole aria-hidden="true" className="text-amber-300" />
                <AlertTitle>Protected content is unavailable</AlertTitle>
                <AlertDescription className="max-w-4xl">
                  This browser has no active Device and its required v3
                  cryptographic provider is unavailable. Manifest lanes and
                  Values were not requested. Non-secret Team administration
                  remains available.
                  <code className="ml-2 rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-amber-200">
                    {boundary.crypto.problemCode ??
                      "crypto_provider_unavailable"}
                  </code>
                </AlertDescription>
              </Alert>
            ) : null}
          </section>

          <section
            className="mt-8 grid scroll-mt-24 gap-4 xl:grid-cols-[1fr_0.62fr]"
            id="revisions"
          >
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <History aria-hidden="true" className="size-4 text-primary" />{" "}
                  <h2>Revision history</h2>
                </CardTitle>
                <CardDescription>
                  Immutable continuity metadata. Protected Manifest contents
                  remain undisclosed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Revision</TableHead>
                      <TableHead>Recorded</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead className="text-right">State</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      ["rev_0184", "14 min ago", "ari…9c2", "Current head"],
                      ["rev_0183", "Yesterday", "mina…31a", "Verified"],
                      ["rev_0182", "28 Aug", "ari…9c2", "Verified"],
                    ].map(([revision, recorded, actor, state]) => (
                      <TableRow key={revision}>
                        <TableCell className="font-mono text-xs">
                          {revision}
                        </TableCell>
                        <TableCell>{recorded}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {actor}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge
                            variant={
                              state === "Current head" ? "default" : "outline"
                            }
                          >
                            {state}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
              <CardFooter className="gap-2 text-xs text-muted-foreground">
                <LockKeyhole aria-hidden="true" className="size-3" /> Names and
                Values are decrypted only by an authorized Device.
              </CardFooter>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <GitBranch aria-hidden="true" className="size-4" /> Project
                  linkage
                </CardTitle>
                <CardDescription>
                  Descriptive identity only—it grants no DotRelay authority.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-xs text-muted-foreground">
                    GitHub Repository
                  </p>
                  <p className="mt-1 font-medium">LSP-Software / DotRelay</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Stable repository id
                  </p>
                  <p className="mt-1 font-mono text-xs">R_884193201</p>
                </div>
                <Separator />
                <p className="text-xs leading-5 text-muted-foreground">
                  Repository rename or transfer does not change this linkage.
                  GitHub permissions never create a Membership.
                </p>
              </CardContent>
            </Card>
          </section>

          <section className="mt-8 scroll-mt-24" id="administration">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
                  Non-secret controls
                </p>
                <h2 className="mt-2 font-heading text-2xl font-semibold">
                  Administration
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="preview-role">Preview role</Label>
                <select
                  aria-label="Preview Membership role"
                  className="h-9 rounded-lg border border-input bg-input/30 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            </div>

            <Alert className="mb-4 bg-card/60">
              <ShieldCheck aria-hidden="true" className="text-primary" />
              <AlertTitle>{role} Membership</AlertTitle>
              <AlertDescription>{roleDisclosure[role]}</AlertDescription>
            </Alert>

            <Tabs defaultValue="members">
              <TabsList aria-label="Administration areas">
                <TabsTrigger value="members">Members</TabsTrigger>
                <TabsTrigger value="resources">Resources</TabsTrigger>
              </TabsList>
              <TabsContent className="mt-4" value="members">
                <Card>
                  <CardHeader>
                    <CardTitle>Team Memberships</CardTitle>
                    <CardDescription>
                      Invitations target stable GitHub subjects and expire after
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
                          <TableHead>User / subject</TableHead>
                          <TableHead>Role</TableHead>
                          <TableHead>Lifecycle</TableHead>
                          <TableHead className="text-right">
                            Authority
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell>
                            <div className="font-medium">Ari Stone</div>
                            <div className="font-mono text-[10px] text-muted-foreground">
                              github:710284
                            </div>
                          </TableCell>
                          <TableCell>Owner</TableCell>
                          <TableCell>
                            <Badge
                              className="bg-primary/15 text-primary"
                              variant="outline"
                            >
                              Active
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            DotRelay Membership
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>
                            <div className="font-medium">Mina Patel</div>
                            <div className="font-mono text-[10px] text-muted-foreground">
                              github:2931041
                            </div>
                          </TableCell>
                          <TableCell>Member</TableCell>
                          <TableCell>
                            <Badge variant="outline">Active</Badge>
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            DotRelay Membership
                          </TableCell>
                        </TableRow>
                        {invitations.map((subject) => (
                          <TableRow key={subject}>
                            <TableCell>
                              <div className="font-medium">
                                Invitation accepted
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
                                <Clock3 aria-hidden="true" /> Pending key grant
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">
                              No protected access
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent className="mt-4" value="resources">
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card>
                    <CardHeader>
                      <Badge className="mb-2" variant="outline">
                        Project
                      </Badge>
                      <CardTitle>DotRelay</CardTitle>
                      <CardDescription>
                        Stable GitHub repository id R_884193201
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
                  <Card>
                    <CardHeader>
                      <Badge className="mb-2" variant="outline">
                        Environment
                      </Badge>
                      <CardTitle>production</CardTitle>
                      <CardDescription>
                        Current head rev_0184 · opaque continuity reference
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex items-center justify-between gap-4">
                      <Badge
                        data-testid="environment-lifecycle"
                        variant={
                          environmentLifecycle === "ACTIVE"
                            ? "default"
                            : "secondary"
                        }
                      >
                        {environmentLifecycle === "ACTIVE"
                          ? "Active"
                          : "Archived"}
                      </Badge>
                      <LifecycleDialog
                        disabled={
                          !canAdminister || projectLifecycle === "ARCHIVED"
                        }
                        lifecycle={environmentLifecycle}
                        onConfirm={() =>
                          setEnvironmentLifecycle((value) =>
                            value === "ACTIVE" ? "ARCHIVED" : "ACTIVE",
                          )
                        }
                        resource="Environment"
                      />
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            </Tabs>
          </section>

          <section
            className="mt-8 grid scroll-mt-24 gap-4 pb-12 md:grid-cols-2"
            id="devices"
          >
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MonitorSmartphone
                    aria-hidden="true"
                    className="size-4 text-amber-300"
                  />{" "}
                  Devices
                </CardTitle>
                <CardDescription>
                  A Device is a client installation authorized for exactly one
                  User.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  No active Device is bound to this browser. Session
                  authentication alone cannot reveal protected content.
                </p>
              </CardContent>
              <CardFooter>
                <Button variant="outline">
                  <RefreshCcw aria-hidden="true" /> Begin Device authorization
                </Button>
              </CardFooter>
            </Card>
            <Card id="recovery">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound
                    aria-hidden="true"
                    className="size-4 text-primary"
                  />{" "}
                  Recovery
                </CardTitle>
                <CardDescription>
                  A Recovery Kit can authorize a replacement Device.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Recovery material is processed locally only after Server
                  Profile trust is established.
                </p>
              </CardContent>
              <CardFooter>
                <Button variant="outline">Open Recovery Kit flow</Button>
              </CardFooter>
            </Card>
          </section>
        </main>
      </div>

      <Dialog onOpenChange={setInvitationOpen} open={invitationOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a Member</DialogTitle>
            <DialogDescription>
              Address this single-use, seven-day invitation to a stable GitHub
              provider subject—not an email or mutable login.
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
            <ShieldAlert aria-hidden="true" />
            <AlertTitle>Pending after acceptance</AlertTitle>
            <AlertDescription>
              The Membership remains pending until its complete key grant set is
              provisioned.
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
