"use client";

import { Download, LogOut, Trash2 } from "lucide-react";
import { useState } from "react";
import { InlineCommand } from "@/components/inline-command";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
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
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ACCOUNT_DELETION_PHRASE,
  type AccountDeletionPlan,
  deleteAccount,
  deleteTeam,
  downloadAccountExport,
  fetchAccountDeletionPlan,
  type LifecycleDevice,
  type LifecycleResult,
  leaveTeam,
} from "@/lib/account-lifecycle";
import type { MembershipRole } from "@/lib/workspace-boundary";
import { PROJECT_ROTATE_COMMAND } from "./team-dialogs";

// Leaving and deleting a Team (ADR 0019), and exporting or deleting the
// account (ADR 0018). Every destructive action asks for a typed
// confirmation; the service checks it again, and needs this browser's Device
// while the account has one (ADR 0024).

const TypedConfirmation = ({
  id,
  expected,
  value,
  onChange,
}: Readonly<{
  readonly id: string;
  readonly expected: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}>) => (
  <div className="grid gap-2">
    <Label htmlFor={id}>
      Type <span className="font-mono">{expected}</span> to confirm
    </Label>
    <Input
      autoComplete="off"
      data-testid={id}
      id={id}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      value={value}
    />
  </div>
);

export const TeamLifecycleCard = ({
  apiOrigin,
  teamId,
  teamName,
  role,
  deviceId,
  onChanged,
}: Readonly<{
  readonly apiOrigin: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly role: MembershipRole;
  readonly deviceId?: string | undefined;
  readonly onChanged: () => void;
}>) => {
  const [dialog, setDialog] = useState<"leave" | "delete" | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setDialog(null);
    setTyped("");
    setError(null);
  };
  const run = async (action: () => Promise<LifecycleResult<unknown>>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.ok) {
      close();
      onChanged();
    } else setError(result.message);
  };
  return (
    <Card
      className="mt-10 border-destructive/30"
      data-testid="team-lifecycle-card"
    >
      <CardHeader>
        <CardTitle>Leave or delete this team</CardTitle>
        <CardDescription>
          Leaving removes your access. Deleting removes the team for everyone
          and can&apos;t be undone.
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          data-testid="leave-team"
          onClick={() => setDialog("leave")}
          variant="outline"
        >
          <LogOut aria-hidden="true" /> Leave team
        </Button>
        {role === "OWNER" ? (
          <Button
            data-testid="delete-team"
            onClick={() => setDialog("delete")}
            variant="destructive"
          >
            <Trash2 aria-hidden="true" /> Delete team
          </Button>
        ) : null}
      </CardFooter>
      <Dialog
        onOpenChange={(open) => {
          if (!open) close();
        }}
        open={dialog !== null}
      >
        <DialogContent data-testid={`${dialog}-team-dialog`} role="alertdialog">
          {dialog === "leave" ? (
            <>
              <DialogHeader>
                <DialogTitle>Leave {teamName}?</DialogTitle>
                <DialogDescription>
                  You lose access to the team's projects at once. To come back
                  you need a new invitation. Values you already downloaded stay
                  on your devices, so the team's owners should run{" "}
                  <InlineCommand value={PROJECT_ROTATE_COMMAND} /> in each
                  project.
                </DialogDescription>
              </DialogHeader>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button
                  data-testid="confirm-leave-team"
                  disabled={busy}
                  onClick={() =>
                    void run(() => leaveTeam(apiOrigin, teamId, deviceId))
                  }
                  variant="destructive"
                >
                  Leave team
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Delete {teamName}?</DialogTitle>
                <DialogDescription>
                  Every member loses access to the team's projects, environments
                  and history at once, you included. The encrypted data is
                  erased from the server after 30 days. This can't be undone
                  from DotRelay.
                </DialogDescription>
              </DialogHeader>
              <TypedConfirmation
                expected={teamName}
                id="delete-team-confirmation"
                onChange={setTyped}
                value={typed}
              />
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button
                  data-testid="confirm-delete-team"
                  disabled={busy || typed !== teamName}
                  onClick={() =>
                    void run(() =>
                      deleteTeam(apiOrigin, teamId, typed, deviceId),
                    )
                  }
                  variant="destructive"
                >
                  Delete team
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
};

const TeamList = ({
  title,
  teams,
}: Readonly<{
  readonly title: string;
  readonly teams: AccountDeletionPlan["teamsLeft"];
}>) =>
  teams.length === 0 ? null : (
    <div className="grid gap-1 text-sm">
      <p className="font-medium">{title}</p>
      <ul className="list-disc pl-5 text-muted-foreground">
        {teams.map((team) => (
          <li key={team.teamId}>{team.name}</li>
        ))}
      </ul>
    </div>
  );

export const AccountSettingsSection = ({
  apiOrigin,
  userId,
  device,
  onDeleted,
}: Readonly<{
  readonly apiOrigin: string;
  readonly userId: string;
  /** This browser's Device, when it has one. */
  readonly device?: LifecycleDevice | undefined;
  readonly onDeleted: () => void;
}>) => {
  const [exportState, setExportState] = useState<
    "idle" | "busy" | { error: string }
  >("idle");
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<AccountDeletionPlan | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startExport = async () => {
    setExportState("busy");
    const result = await downloadAccountExport(apiOrigin, device?.deviceId);
    setExportState(result.ok ? "idle" : { error: result.message });
  };
  const openDeletion = async () => {
    setOpen(true);
    setPlan(null);
    setTyped("");
    setError(null);
    const result = await fetchAccountDeletionPlan(apiOrigin);
    if (result.ok) setPlan(result.data);
    else setError(result.message);
  };
  const confirmDeletion = async () => {
    setBusy(true);
    setError(null);
    const result = await deleteAccount(apiOrigin, userId, device);
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      onDeleted();
    } else setError(result.message);
  };
  const blocked = (plan?.blockingTeams.length ?? 0) > 0;

  return (
    <section data-testid="account-settings" id="account">
      <h2 className="font-heading text-lg font-semibold">Your account</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Your DotRelay account on this server.
      </p>
      <div className="mt-4 grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Export my data</CardTitle>
            <CardDescription>
              A JSON file of what this server holds about your account: profile,
              teams and roles, devices, invitations, sessions, and activity
              timestamps. It contains no encrypted values or keys. To keep a
              copy of your values, run <InlineCommand value="dotrelay pull" />{" "}
              or <InlineCommand value="dotrelay export" /> on a device.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-wrap items-center gap-3">
            <Button
              data-testid="export-account"
              disabled={exportState === "busy"}
              onClick={() => void startExport()}
              variant="outline"
            >
              <Download aria-hidden="true" />
              {exportState === "busy" ? "Preparing…" : "Export my data"}
            </Button>
            {typeof exportState === "object" ? (
              <p className="text-sm text-destructive" role="alert">
                {exportState.error}
              </p>
            ) : null}
          </CardFooter>
        </Card>
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle>Delete account</CardTitle>
            <CardDescription>
              Deletes your sign-in, sessions, devices' keys, and recovery
              methods on this server. Your teammates keep the history you wrote,
              shown as from a deleted user.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              data-testid="delete-account"
              onClick={() => void openDeletion()}
              variant="destructive"
            >
              <Trash2 aria-hidden="true" /> Delete account
            </Button>
          </CardFooter>
        </Card>
      </div>
      <Dialog
        onOpenChange={(next) => {
          if (!next) setOpen(false);
        }}
        open={open}
      >
        <DialogContent data-testid="delete-account-dialog" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              This can't be undone. You're signed out everywhere, every device
              stops working, and your recovery code, password and passkeys stop
              unlocking anything. Signing in again with the same GitHub account
              starts a new, empty account.
            </DialogDescription>
          </DialogHeader>
          <CardContent className="grid gap-3 px-0">
            {plan === null && !error ? (
              <p className="text-sm text-muted-foreground">
                Checking your teams…
              </p>
            ) : null}
            {blocked ? (
              <Alert className="border-destructive/30 bg-destructive/10">
                <AlertTitle>Transfer ownership first</AlertTitle>
                <AlertDescription>
                  You're the only owner of{" "}
                  {plan?.blockingTeams.map((team) => team.name).join(", ")}.
                  Make another active member an owner, or delete the team,
                  before deleting your account.
                </AlertDescription>
              </Alert>
            ) : null}
            {plan ? (
              <>
                <TeamList
                  teams={plan.teamsDeleted}
                  title="Deleted with your account (you're the only member):"
                />
                <TeamList
                  teams={plan.teamsLeft}
                  title="You leave these teams; their owners should rotate keys:"
                />
              </>
            ) : null}
            {plan && !blocked ? (
              <TypedConfirmation
                expected={ACCOUNT_DELETION_PHRASE}
                id="delete-account-confirmation"
                onChange={setTyped}
                value={typed}
              />
            ) : null}
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </CardContent>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              data-testid="confirm-delete-account"
              disabled={
                busy ||
                plan === null ||
                blocked ||
                typed !== ACCOUNT_DELETION_PHRASE
              }
              onClick={() => void confirmDeletion()}
              variant="destructive"
            >
              Delete account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
