import {
  KeyRound,
  LockKeyhole,
  MonitorSmartphone,
  WifiOff,
} from "lucide-react";
import { CopyableCommand } from "@/components/copyable-command";
import { InlineCommand } from "@/components/inline-command";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AccountKeyWrapperEntry } from "@/lib/account-keys";
import type {
  AccountRecoveryUnlockMethod,
  UnlockMethodOffer,
} from "@/lib/account-recovery";
import { cn } from "@/lib/utils";

// The Recovery area: sign-in, device setup, offline retry, recovery-code
// setup, account unlock, and the unlocked status with its per-method
// actions, plus the one-time code dialog and the remove-password dialog.
// Presentation only: every value and action arrives through props.

const recoveryFormatDate = (iso: string | undefined): string => {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

export type RecoveryAreaProps = Readonly<{
  readonly sessionActive: boolean;
  readonly deviceActive: boolean;
  readonly connection: "loading" | "online" | "offline";
  readonly deviceSetupInProgress: boolean;
  readonly onDeviceSetup: () => void;
  readonly onRetry: () => void;
  readonly recoveryBusy: boolean;
  readonly recoveryMessage: string | null;
  readonly recoveryError: string | null;
  readonly recoveryWrappers: readonly AccountKeyWrapperEntry[];
  readonly passkeyAvailable: boolean;
  readonly unlockMethodOffers: readonly UnlockMethodOffer[];
  readonly unlockMethod: AccountRecoveryUnlockMethod;
  readonly onUnlockMethodSelected: (
    method: AccountRecoveryUnlockMethod,
  ) => void;
  readonly accountUnlocked: boolean;
  readonly onSetupRecovery: () => void;
  readonly onUnlock: (
    method: AccountRecoveryUnlockMethod,
    secret: string,
  ) => void;
  readonly unlockInput: string;
  readonly onUnlockInput: (value: string) => void;
  readonly password: string;
  readonly onPassword: (value: string) => void;
  readonly transferIdInput: string;
  readonly onTransferIdInput: (value: string) => void;
  readonly peerDevices:
    | readonly Readonly<{ readonly id: string }>[]
    | undefined;
  readonly sentTransfer: Readonly<{
    readonly transferId: string;
    readonly expiresAt: string;
    readonly recipientDeviceId: string;
  }> | null;
  readonly transferTarget: string | null;
  readonly onTransferTarget: (value: string | null) => void;
  readonly addPasswordOpen: boolean;
  readonly addPassword: string;
  readonly onAddPassword: (value: string) => void;
  readonly onAddPasswordOpen: (open: boolean) => void;
  readonly onRotateRecoveryCode: () => void;
  readonly onAddEncryptionPassword: () => void;
  readonly onRemovePasswordDialogOpen: (open: boolean) => void;
  readonly onAddPasskey: () => void;
  readonly onRemovePasskeyDialogOpen: (open: boolean) => void;
  readonly onSendTransfer: () => void;
}>;

export const RecoveryArea = ({
  sessionActive,
  deviceActive,
  connection,
  deviceSetupInProgress,
  onDeviceSetup,
  onRetry,
  recoveryBusy,
  recoveryMessage,
  recoveryError,
  recoveryWrappers,
  passkeyAvailable,
  unlockMethodOffers,
  unlockMethod,
  onUnlockMethodSelected,
  accountUnlocked,
  onSetupRecovery,
  onUnlock,
  unlockInput,
  onUnlockInput,
  password,
  onPassword,
  transferIdInput,
  onTransferIdInput,
  peerDevices,
  sentTransfer,
  transferTarget,
  onTransferTarget,
  addPasswordOpen,
  addPassword,
  onAddPassword,
  onAddPasswordOpen,
  onRotateRecoveryCode,
  onAddEncryptionPassword,
  onAddPasskey,
  onRemovePasswordDialogOpen,
  onRemovePasskeyDialogOpen,
  onSendTransfer,
}: RecoveryAreaProps) => {
  return (
    <section id="recovery" data-testid="recovery-area">
      <h1 className="font-heading text-3xl font-semibold">Recovery</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Your account's encryption key stays on your devices. If every device is
        lost, one of the recovery methods below unlocks it again.
      </p>
      {recoveryError ? (
        <Alert
          className="mt-4 border-destructive/30 bg-destructive/10"
          role="alert"
        >
          <AlertTitle>Recovery needs attention</AlertTitle>
          <AlertDescription>{recoveryError}</AlertDescription>
        </Alert>
      ) : null}
      {recoveryMessage ? (
        <p
          className="mt-4 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-primary"
          role="status"
        >
          {recoveryMessage}
        </p>
      ) : null}
      {!sessionActive ? (
        <Card className="mt-6" data-testid="recovery-signin">
          <CardHeader>
            <CardTitle>Sign in first</CardTitle>
            <CardDescription>
              Signing in with GitHub only identifies your account. It never
              decrypts anything: the values stay ciphertext on the server until
              a device unlocks the account.
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
      ) : !deviceActive ? (
        <Card className="mt-6" data-testid="recovery-device-setup">
          <CardHeader>
            <CardTitle>Set up this browser</CardTitle>
            <CardDescription>
              Recovery methods act on this browser's Device, which doesn't exist
              yet. Set up this browser first; it takes a moment and stores its
              keys on this machine.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              disabled={deviceSetupInProgress}
              onClick={() => void onDeviceSetup()}
            >
              {deviceSetupInProgress ? "Setting up…" : "Set up browser"}
            </Button>
          </CardFooter>
        </Card>
      ) : connection === "offline" ? (
        <Card className="mt-6" data-testid="recovery-offline">
          <CardHeader>
            <CardTitle>
              <span className="flex items-center gap-2">
                <WifiOff aria-hidden="true" className="size-4 text-amber-300" />
                Recovery needs a connection to this server
              </span>
            </CardTitle>
            <CardDescription>
              The service that keeps your account's recovery methods is
              unreachable right now. Nothing was changed.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button disabled={recoveryBusy} onClick={() => onRetry()}>
              Try again
            </Button>
          </CardFooter>
        </Card>
      ) : recoveryWrappers.length === 0 ? (
        <div data-testid="recovery-setup">
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>
                <span className="flex items-center gap-2">
                  <KeyRound
                    aria-hidden="true"
                    className="size-4 text-primary"
                  />
                  Protect this account
                </span>
              </CardTitle>
              <CardDescription>
                This account has no recovery methods yet. Setting up creates the
                account's key in this browser and a recovery code that can
                unlock it again if every device is lost.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                Your values are stored as ciphertext on the server. Signing in
                with GitHub never decrypts them, and if every recovery method
                and every device is ever lost, the content can't be recovered. A
                saved recovery code is the one thing that can.
              </p>
              <p>
                The key this browser creates stays in memory for this session
                only; the next time you visit, unlock the account again with the
                code or another method.
              </p>
            </CardContent>
            <CardFooter>
              <Button disabled={recoveryBusy} onClick={() => onSetupRecovery()}>
                {recoveryBusy ? "Setting up…" : "Create recovery code"}
              </Button>
            </CardFooter>
          </Card>
        </div>
      ) : !accountUnlocked ? (
        <div data-testid="recovery-unlock">
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>
                <span className="flex items-center gap-2">
                  <LockKeyhole
                    aria-hidden="true"
                    className="size-4 text-primary"
                  />
                  Unlock this account
                </span>
              </CardTitle>
              <CardDescription>
                Choose how this browser unlocks the account. The key stays in
                memory for this session only; it is never stored in the browser.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <fieldset
                aria-label="Unlock method"
                className="m-0 min-w-0 border-0 p-0"
              >
                <div className="flex flex-wrap gap-2">
                  {unlockMethodOffers.map((method) => (
                    <button
                      aria-pressed={unlockMethod === method.id}
                      className={cn(
                        "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                        !method.available && "opacity-50",
                        unlockMethod === method.id
                          ? "border-primary/50 bg-primary/10 text-primary"
                          : "border-input bg-input/30 hover:bg-muted/40",
                      )}
                      data-testid={`recovery-method-${method.id}`}
                      disabled={!method.available}
                      key={method.id}
                      onClick={() => onUnlockMethodSelected(method.id)}
                      type="button"
                    >
                      {method.label}
                      {!method.available ? (
                        <span className="text-xs text-muted-foreground">
                          {method.note ?? "not set up"}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </fieldset>
              {unlockMethod === "recovery-code" ? (
                <div className="space-y-2">
                  <Label htmlFor="recovery-code-input">Recovery code</Label>
                  <Input
                    autoComplete="off"
                    data-testid="recovery-code-input"
                    disabled={recoveryBusy}
                    id="recovery-code-input"
                    onChange={(event) => onUnlockInput(event.target.value)}
                    placeholder="XXXX-XXXX-XXXX-…"
                    value={unlockInput}
                  />
                </div>
              ) : null}
              {unlockMethod === "password" ? (
                <div className="space-y-2">
                  <Label htmlFor="unlock-password">Encryption password</Label>
                  <Input
                    data-testid="unlock-password"
                    disabled={recoveryBusy}
                    id="unlock-password"
                    onChange={(event) => onPassword(event.target.value)}
                    type="password"
                    value={password}
                  />
                </div>
              ) : null}
              {unlockMethod === "transfer" ? (
                <div className="space-y-2">
                  <Label htmlFor="transfer-id-input">Transfer ID</Label>
                  <Input
                    autoComplete="off"
                    data-testid="transfer-id-input"
                    disabled={recoveryBusy}
                    id="transfer-id-input"
                    onChange={(event) => onTransferIdInput(event.target.value)}
                    placeholder="0123456789abcdef0123456789abcdef"
                    value={transferIdInput}
                  />
                  <p className="text-xs text-muted-foreground">
                    The sending device shares a short-lived transfer; it expires
                    a few minutes after it was created.
                  </p>
                </div>
              ) : null}
              <div className="flex items-center gap-3">
                <Button
                  data-testid="unlock-account"
                  disabled={
                    recoveryBusy ||
                    (unlockMethod === "recovery-code" && !unlockInput.trim()) ||
                    (unlockMethod === "password" && !password) ||
                    (unlockMethod === "transfer" && !transferIdInput.trim())
                  }
                  onClick={() =>
                    void onUnlock(
                      unlockMethod,
                      unlockMethod === "password"
                        ? password
                        : unlockMethod === "transfer"
                          ? transferIdInput
                          : unlockInput,
                    )
                  }
                >
                  {recoveryBusy ? "Unlocking…" : "Unlock"}
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>If none of these work</CardTitle>
              <CardDescription>
                Your values are stored as ciphertext, and the server never sees
                or decrypts them: signing in with GitHub only identifies the
                account. If every recovery method and every device that holds
                the account's key is lost, the content is unrecoverable. A human
                with the server's database can restore the ciphertext but cannot
                read it.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      ) : (
        <div data-testid="recovery-status">
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>
                <span className="flex items-center gap-2">
                  <KeyRound
                    aria-hidden="true"
                    className="size-4 text-primary"
                  />
                  Account recovery status
                </span>
              </CardTitle>
              <CardDescription>
                This account is unlocked in this browser for the session. The
                key is held in memory only and is gone when the tab closes;
                unlock it again next time with one of these methods.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table aria-label="Recovery methods">
                <TableHeader>
                  <TableRow>
                    <TableHead>Method</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium">Recovery code</TableCell>
                    <TableCell>
                      <Badge
                        className={cn(
                          !recoveryWrappers.some(
                            (wrapper) => wrapper.type === "recovery-code",
                          ) && "text-muted-foreground",
                        )}
                        variant="outline"
                      >
                        {recoveryWrappers.some(
                          (wrapper) => wrapper.type === "recovery-code",
                        )
                          ? `Active since ${recoveryFormatDate(
                              recoveryWrappers.find(
                                (wrapper) => wrapper.type === "recovery-code",
                              )?.createdAt,
                            )}`
                          : "Not set up"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        data-testid="rotate-recovery-code"
                        disabled={recoveryBusy}
                        size="sm"
                        variant="outline"
                        onClick={() => onRotateRecoveryCode()}
                      >
                        Rotate code
                      </Button>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">
                      Encryption password
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={
                          !recoveryWrappers.some(
                            (wrapper) => wrapper.type === "password",
                          )
                            ? "text-muted-foreground"
                            : undefined
                        }
                        variant="outline"
                      >
                        {recoveryWrappers.some(
                          (wrapper) => wrapper.type === "password",
                        )
                          ? "Active"
                          : "Not set up"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {recoveryWrappers.some(
                        (wrapper) => wrapper.type === "password",
                      ) ? (
                        <Button
                          data-testid="remove-encryption-password"
                          disabled={recoveryBusy}
                          size="sm"
                          variant="destructive"
                          onClick={() => onRemovePasswordDialogOpen(true)}
                        >
                          Remove
                        </Button>
                      ) : (
                        <Button
                          data-testid="add-encryption-password"
                          disabled={recoveryBusy}
                          size="sm"
                          variant="outline"
                          onClick={() => onAddPasswordOpen(true)}
                        >
                          Add password
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">Passkey</TableCell>
                    <TableCell>
                      <Badge
                        className={
                          !recoveryWrappers.some(
                            (wrapper) => wrapper.type === "passkey-prf",
                          )
                            ? "text-muted-foreground"
                            : undefined
                        }
                        variant="outline"
                      >
                        {recoveryWrappers.some(
                          (wrapper) => wrapper.type === "passkey-prf",
                        )
                          ? passkeyAvailable
                            ? "Active"
                            : "Active · PRF not supported here"
                          : "Not set up"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {recoveryWrappers.some(
                        (wrapper) => wrapper.type === "passkey-prf",
                      ) ? (
                        <Button
                          data-testid="remove-passkey"
                          disabled={recoveryBusy}
                          size="sm"
                          variant="destructive"
                          onClick={() => onRemovePasskeyDialogOpen(true)}
                        >
                          Remove
                        </Button>
                      ) : (
                        <Button
                          data-testid="add-passkey"
                          disabled={recoveryBusy || !passkeyAvailable}
                          size="sm"
                          variant="outline"
                          onClick={() => onAddPasskey()}
                        >
                          Add passkey
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
            {addPasswordOpen ? (
              <CardContent className="space-y-2 border-t">
                <Label htmlFor="add-encryption-password">
                  New encryption password
                </Label>
                <Input
                  data-testid="add-encryption-password-input"
                  id="add-encryption-password"
                  onChange={(event) => onAddPassword(event.target.value)}
                  type="password"
                  value={addPassword}
                />
                <div className="flex gap-2">
                  <Button
                    data-testid="add-encryption-password-confirm"
                    disabled={recoveryBusy || addPassword.length < 8}
                    onClick={() => onAddEncryptionPassword()}
                  >
                    {recoveryBusy ? "Adding…" : "Add password"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      onAddPassword("");
                      onAddPasswordOpen(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </CardContent>
            ) : null}
            <CardFooter>
              <Button
                data-testid="send-transfer"
                disabled={
                  recoveryBusy || !peerDevices || peerDevices.length === 0
                }
                size="sm"
                variant="outline"
                onClick={() => onTransferTarget(peerDevices?.[0]?.id ?? null)}
              >
                Send the key to another device
              </Button>
            </CardFooter>
          </Card>
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>
                <span className="flex items-center gap-2">
                  <MonitorSmartphone aria-hidden="true" className="size-4" />
                </span>{" "}
                Other devices
              </CardTitle>
              <CardDescription>
                Hand this account's key to another of your devices: it is sealed
                to that device and redeemable once, for a few minutes.
              </CardDescription>
            </CardHeader>
            {sentTransfer ? (
              <CardContent className="space-y-3">
                <div
                  className="rounded-lg border border-primary/25 bg-primary/5 p-3"
                  role="status"
                >
                  <p className="text-sm font-medium">
                    Transfer staged for {sentTransfer.recipientDeviceId}
                  </p>
                  <p className="mt-1 font-mono text-xs">
                    {sentTransfer.transferId}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Redeemable until{" "}
                    {new Date(sentTransfer.expiresAt).toLocaleString()}. The
                    receiving device enters it in its own Recovery area, or the
                    CLI uses{" "}
                    <InlineCommand
                      value={`dotrelay device recover --transfer ${sentTransfer.transferId}`}
                    />
                    .
                  </p>
                </div>
              </CardContent>
            ) : null}
            {peerDevices && peerDevices.length > 0 ? (
              <CardContent className="space-y-2">
                <Label htmlFor="transfer-target">
                  Device to receive the key
                </Label>
                <select
                  className="flex h-9 w-full rounded-lg border border-input bg-input/30 px-3 text-sm outline-none"
                  disabled={recoveryBusy}
                  id="transfer-target"
                  onChange={(event) => onTransferTarget(event.target.value)}
                  value={transferTarget ?? ""}
                >
                  <option value="" disabled>
                    Choose a device
                  </option>
                  {peerDevices.map((peer) => (
                    <option key={peer.id} value={peer.id}>
                      {peer.id}
                    </option>
                  ))}
                </select>
                <Button
                  data-testid="send-transfer-confirm"
                  disabled={recoveryBusy || transferTarget === null}
                  size="sm"
                  variant="outline"
                  onClick={() => onSendTransfer()}
                >
                  {recoveryBusy ? "Sending…" : "Create transfer"}
                </Button>
              </CardContent>
            ) : (
              <CardContent className="text-sm text-muted-foreground">
                No other devices are enrolled on this account yet.
              </CardContent>
            )}
          </Card>
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>If you lose everything</CardTitle>
              <CardDescription>
                Your values are stored as ciphertext. Signing in with GitHub
                never decrypts them: the server cannot read your values, and
                neither can anyone with the server's database. If every recovery
                method above is lost and every device that held the account's
                key is gone, the content is unrecoverable — that is the price of
                the key never leaving your devices.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      )}
    </section>
  );
};

export type RecoveryCodeDialogProps = Readonly<{
  readonly code: string | null;
  readonly note: string | null;
  readonly onRequestClose: () => void;
}>;

export const RecoveryCodeDialog = ({
  code,
  note,
  onRequestClose,
}: RecoveryCodeDialogProps) => (
  <Dialog
    onOpenChange={(open) => {
      if (open) return;
      // Closing the dialog without confirming discards the code: the
      // user can still rotate it later, and the note said so.
      onRequestClose();
    }}
    open={code !== null}
  >
    <DialogContent data-testid="recovery-code-dialog" role="alertdialog">
      <DialogHeader>
        <DialogTitle>Save this recovery code</DialogTitle>
        <DialogDescription>
          {note ??
            "This code unlocks the account's key if every device is lost."}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <Label>Your recovery code</Label>
        <CopyableCommand data-testid="recovery-code-value" value={code ?? ""} />
        <p className="text-sm text-muted-foreground">
          The code is shown once and is never stored in this browser. If you
          lose it, and every other recovery method, the account's content
          becomes unrecoverable.
        </p>
      </div>
      <DialogFooter>
        <Button
          data-testid="recovery-code-saved"
          onClick={() => {
            onRequestClose();
          }}
        >
          I saved it
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export type RemovePasswordDialogProps = Readonly<{
  readonly open: boolean;
  readonly busy: boolean;
  readonly onDialogOpen: (open: boolean) => void;
  readonly onConfirm: () => void;
}>;

export const RemovePasswordDialog = ({
  open,
  busy,
  onDialogOpen,
  onConfirm,
}: RemovePasswordDialogProps) => (
  <Dialog onOpenChange={(open) => onDialogOpen(open)} open={open}>
    <DialogContent data-testid="remove-password-dialog" role="alertdialog">
      <DialogHeader>
        <DialogTitle>Remove the encryption password?</DialogTitle>
        <DialogDescription>
          The account keeps at least one recovery method, so removing the
          password is refused if it is the last one. Your recovery code stays in
          place either way.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button
          data-testid="remove-password-confirm"
          disabled={busy}
          variant="destructive"
          onClick={() => onConfirm()}
        >
          {busy ? "Removing…" : "Remove password"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export type RemovePasskeyDialogProps = Readonly<{
  readonly open: boolean;
  readonly busy: boolean;
  readonly onDialogOpen: (open: boolean) => void;
  readonly onConfirm: () => void;
}>;

export const RemovePasskeyDialog = ({
  open,
  busy,
  onDialogOpen,
  onConfirm,
}: RemovePasskeyDialogProps) => (
  <Dialog onOpenChange={(open) => onDialogOpen(open)} open={open}>
    <DialogContent data-testid="remove-passkey-dialog" role="alertdialog">
      <DialogHeader>
        <DialogTitle>Remove the passkey?</DialogTitle>
        <DialogDescription>
          The passkey will stop unlocking this account. Your recovery code stays
          in place, and the account always keeps at least one recovery method.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button
          data-testid="remove-passkey-confirm"
          disabled={busy}
          variant="destructive"
          onClick={() => onConfirm()}
        >
          {busy ? "Removing…" : "Remove passkey"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
