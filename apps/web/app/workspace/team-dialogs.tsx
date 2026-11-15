"use client";

import { KeyRound } from "lucide-react";
import { CopyableCommand } from "@/components/copyable-command";
import { InlineCommand } from "@/components/inline-command";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MembershipRole } from "@/lib/workspace-boundary";

// Confirmation and follow-up surfaces for the Team and Devices views. Removing
// a Member or revoking a Device stops future access, but cannot take back keys
// or values that were already downloaded, so both flows end with the same
// rotation guidance.

export const PROJECT_ROTATE_COMMAND = "dotrelay project rotate";

const roleName = (role: MembershipRole): string =>
  role === "OWNER" ? "Owner" : role === "ADMIN" ? "Admin" : "Member";

// What the target role can do, said from the point of view of the person
// being changed.
const roleConsequence = (role: MembershipRole): string =>
  role === "OWNER"
    ? "Owners can change anyone's role, remove any member (including you), and manage every project and environment."
    : role === "ADMIN"
      ? "Admins can invite and remove members, share project keys, and manage projects and environments."
      : "Members can read this team's projects and manage their own values. They can't invite, remove, or manage anyone.";

export const KeyRotationSteps = ({
  subject,
}: Readonly<{ readonly subject: "member" | "device" }>) => (
  <div className="grid gap-2 text-sm" data-testid="key-rotation-guidance">
    <p className="text-muted-foreground">
      {subject === "member"
        ? "They keep any keys and values they already downloaded. In each of this team's project repositories, rotate the project key so new values use a key they never had, then change any sensitive values they could read."
        : "That device keeps any keys and values it already downloaded. If it was lost or someone else may have it, rotate the key of each project it could read (run this in the project's repository), then change sensitive values."}
    </p>
    <CopyableCommand value={PROJECT_ROTATE_COMMAND} />
  </div>
);

export type RemovalTarget = Readonly<{
  readonly membershipId: string;
  readonly label: string;
}>;

export const RemoveMemberDialog = ({
  target,
  teamName,
  onCancel,
  onConfirm,
}: Readonly<{
  readonly target: RemovalTarget | null;
  readonly teamName: string;
  readonly onCancel: () => void;
  readonly onConfirm: (target: RemovalTarget) => void;
}>) => (
  <Dialog
    onOpenChange={(open) => {
      if (!open) onCancel();
    }}
    open={target !== null}
  >
    <DialogContent data-testid="remove-member-dialog" role="alertdialog">
      <DialogHeader>
        <DialogTitle>
          Remove {target?.label ?? "this member"} from {teamName}?
        </DialogTitle>
        <DialogDescription>
          Removal is permanent. To add them back you'll need to send a new
          invitation and share project keys with them again.
        </DialogDescription>
      </DialogHeader>
      <Alert className="border-amber-300/30 bg-amber-300/5">
        <KeyRound aria-hidden="true" className="text-amber-200" />
        <AlertTitle>Removing them doesn't revoke what they have</AlertTitle>
        <AlertDescription>
          Keys and values they already downloaded stay readable to them. After
          removing them, run <InlineCommand value={PROJECT_ROTATE_COMMAND} /> in
          each project's repository and change sensitive values.
        </AlertDescription>
      </Alert>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button
          onClick={() => {
            if (target) onConfirm(target);
          }}
          variant="destructive"
        >
          Remove member
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export type InvitationTarget = Readonly<{
  readonly invitationId: string;
  readonly label: string;
}>;

// Cancelling stops the invitation from being accepted. Nothing was shared
// with an invitee yet, so there is no rotation to follow.
export const CancelInvitationDialog = ({
  target,
  onCancel,
  onConfirm,
}: Readonly<{
  readonly target: InvitationTarget | null;
  readonly onCancel: () => void;
  readonly onConfirm: (target: InvitationTarget) => void;
}>) => (
  <Dialog
    onOpenChange={(open) => {
      if (!open) onCancel();
    }}
    open={target !== null}
  >
    <DialogContent data-testid="cancel-invitation-dialog" role="alertdialog">
      <DialogHeader>
        <DialogTitle>
          Cancel the invitation for {target?.label ?? "this person"}?
        </DialogTitle>
        <DialogDescription>
          They won't be able to accept it. To add them later, send a new
          invitation.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          Keep invitation
        </DialogClose>
        <Button
          onClick={() => {
            if (target) onConfirm(target);
          }}
          variant="destructive"
        >
          Cancel invitation
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const DeclineInvitationDialog = ({
  target,
  onCancel,
  onConfirm,
}: Readonly<{
  readonly target: InvitationTarget | null;
  readonly onCancel: () => void;
  readonly onConfirm: (target: InvitationTarget) => void;
}>) => (
  <Dialog
    onOpenChange={(open) => {
      if (!open) onCancel();
    }}
    open={target !== null}
  >
    <DialogContent data-testid="decline-invitation-dialog" role="alertdialog">
      <DialogHeader>
        <DialogTitle>
          Decline the invitation to {target?.label ?? "this team"}?
        </DialogTitle>
        <DialogDescription>
          To join later, an owner or admin of the team has to invite you again.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          Keep invitation
        </DialogClose>
        <Button
          onClick={() => {
            if (target) onConfirm(target);
          }}
          variant="destructive"
        >
          Decline
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const MemberRemovedNotice = ({
  label,
  onDismiss,
}: Readonly<{ readonly label: string; readonly onDismiss: () => void }>) => (
  <Alert
    className="mb-4 border-amber-300/30 bg-amber-300/5"
    data-testid="member-removed-notice"
    role="status"
  >
    <KeyRound aria-hidden="true" className="text-amber-200" />
    <AlertTitle>{label} was removed. Rotate project keys next.</AlertTitle>
    <AlertDescription>
      <KeyRotationSteps subject="member" />
    </AlertDescription>
    <AlertAction>
      <Button onClick={onDismiss} size="sm" type="button" variant="ghost">
        Dismiss
      </Button>
    </AlertAction>
  </Alert>
);

export type RoleChangeTarget = Readonly<{
  readonly membershipId: string;
  readonly label: string;
  readonly from: MembershipRole;
  readonly to: MembershipRole;
}>;

export const RoleChangeDialog = ({
  target,
  onCancel,
  onConfirm,
}: Readonly<{
  readonly target: RoleChangeTarget | null;
  readonly onCancel: () => void;
  readonly onConfirm: (target: RoleChangeTarget) => void;
}>) => {
  const promotion =
    target !== null &&
    (target.to === "OWNER" ||
      (target.to === "ADMIN" && target.from === "MEMBER"));
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open={target !== null}
    >
      <DialogContent data-testid="role-change-dialog" role="alertdialog">
        <DialogHeader>
          <DialogTitle>
            Make {target?.label ?? "this member"}{" "}
            {target ? `${target.to === "ADMIN" ? "an" : "a"} ` : ""}
            {target ? roleName(target.to) : ""}?
          </DialogTitle>
          <DialogDescription>
            {target ? (
              <>
                Their role changes from {roleName(target.from)} to{" "}
                {roleName(target.to)}. {roleConsequence(target.to)}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            onClick={() => {
              if (target) onConfirm(target);
            }}
            variant={promotion ? "default" : "outline"}
          >
            Change role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const DeviceRevokedDialog = ({
  open,
  onContinue,
}: Readonly<{ readonly open: boolean; readonly onContinue: () => void }>) => (
  <Dialog
    onOpenChange={(next) => {
      if (!next) onContinue();
    }}
    open={open}
  >
    <DialogContent data-testid="device-revoked-dialog" role="alertdialog">
      <DialogHeader>
        <DialogTitle>Device revoked</DialogTitle>
        <DialogDescription>
          The device can no longer sync, and every browser and CLI session on
          your account was signed out, including this one.
        </DialogDescription>
      </DialogHeader>
      <KeyRotationSteps subject="device" />
      <DialogFooter>
        <Button onClick={onContinue}>Continue to sign in</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const RevokeDeviceDialog = ({
  target,
  onCancel,
  onConfirm,
}: Readonly<{
  readonly target: Readonly<{ id: string; label: string }> | null;
  readonly onCancel: () => void;
  readonly onConfirm: (deviceId: string) => void;
}>) => (
  <Dialog
    onOpenChange={(open) => {
      if (!open) onCancel();
    }}
    open={target !== null}
  >
    <DialogContent data-testid="revoke-device-dialog" role="alertdialog">
      <DialogHeader>
        <DialogTitle>Revoke {target?.label ?? "this device"}?</DialogTitle>
        <DialogDescription>
          The device stops syncing, and every browser and CLI session on your
          account is signed out, including this one. Values it already
          downloaded can't be erased from it.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button
          onClick={() => {
            if (target) onConfirm(target.id);
          }}
          variant="destructive"
        >
          Revoke device
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
