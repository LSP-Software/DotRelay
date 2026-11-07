"use client";

import { Ban, Hourglass, ShieldOff, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { GitHubSignInButton } from "@/app/sign-in/github-sign-in-button";
import { CommandText } from "@/components/inline-command";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  attemptDeviceDecision,
  checkDeviceStatus,
  checkServerProfileSession,
  type DeviceApprovalView,
  type DeviceDecision,
  deviceApprovalAttemptView,
  deviceApprovalView,
  deviceDenialAttemptView,
} from "@/lib/device-approval";
import {
  resolveLiveApiOrigin,
  resolveWebOrigin,
} from "@/lib/workspace-boundary";

type DeviceApproveCardProps = Readonly<{
  readonly userCode: string;
}>;

export const DeviceApproveCard = ({ userCode }: DeviceApproveCardProps) => {
  const apiOrigin = resolveLiveApiOrigin() ?? "http://localhost:3001";
  const callbackUrl = `${resolveWebOrigin()}/device?user_code=${encodeURIComponent(userCode)}`;
  const [view, setView] = useState<"checking" | DeviceApprovalView>("checking");
  const [busy, setBusy] = useState(false);
  // The code arrives pre-filled from the URL, so a link someone else sent
  // could carry their terminal's code. Allowing needs an explicit statement
  // that this sign-in was started here.
  const [confirmed, setConfirmed] = useState(false);
  const runRef = useRef(0);

  const settle = useCallback(
    async (run: number) => {
      const [status, session] = await Promise.all([
        checkDeviceStatus(apiOrigin, userCode),
        checkServerProfileSession(apiOrigin),
      ]);
      if (run !== runRef.current) return;
      setView(deviceApprovalView(status, session));
    },
    [apiOrigin, userCode],
  );

  const checkState = useCallback(async () => {
    const run = ++runRef.current;
    setView("checking");
    await settle(run);
  }, [settle]);

  useEffect(() => {
    void checkState();
  }, [checkState]);

  const decide = async (decision: DeviceDecision) => {
    const run = ++runRef.current;
    setBusy(true);
    try {
      const attempt = await attemptDeviceDecision(
        apiOrigin,
        userCode,
        decision,
      );
      if (run !== runRef.current) return;
      const resolved =
        decision === "approve"
          ? deviceApprovalAttemptView(attempt)
          : deviceDenialAttemptView(attempt);
      if (resolved.kind !== "recheck") {
        setView(resolved);
        // A denied code is finished; drop it from the address bar so a reload
        // or shared URL does not bring it back.
        if (resolved.kind === "declined")
          window.history.replaceState(null, "", "/device");
        return;
      }
      // The code may have been processed or the session may have lapsed while
      // the request ran; re-derive the view from a fresh status check.
      setView("checking");
      await settle(run);
    } finally {
      if (run === runRef.current) setBusy(false);
    }
  };

  if (view === "checking")
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Checking this code…
      </p>
    );

  switch (view.kind) {
    case "sign-in":
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Sign in to allow this CLI.
          </p>
          <GitHubSignInButton
            apiOrigin={apiOrigin}
            callbackUrl={callbackUrl}
            errorCallbackURL={callbackUrl}
          />
        </div>
      );
    case "allow":
      return (
        <div className="space-y-4">
          <label className="flex items-start gap-3 text-sm">
            <input
              checked={confirmed}
              className="mt-0.5"
              data-testid="device-approval-confirm"
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>
              I started this sign-in from my own terminal just now, and it shows
              this code.
            </span>
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              data-testid="device-approval-deny"
              disabled={busy}
              onClick={() => void decide("deny")}
              size="lg"
              type="button"
              variant="outline"
            >
              Deny
            </Button>
            <Button
              data-testid="device-approval-allow"
              disabled={busy || !confirmed}
              onClick={() => void decide("approve")}
              size="lg"
              type="button"
            >
              Allow this CLI
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            If you didn&apos;t start this, choose Deny.
          </p>
        </div>
      );
    case "approved":
      return (
        <p
          className="text-sm text-primary"
          data-testid="device-approval-approved"
          role="status"
        >
          Allowed. You can return to the CLI.
        </p>
      );
    case "declined":
      return (
        <p
          className="text-sm text-muted-foreground"
          data-testid="device-approval-declined"
          role="status"
        >
          This CLI request was denied. It has no access to your account.
        </p>
      );
    case "expired":
      return (
        <Alert
          className="border-amber-300/30 bg-amber-300/5"
          data-testid="device-approval-expired"
        >
          <Hourglass aria-hidden="true" className="text-amber-300" />
          <AlertTitle>This code has expired</AlertTitle>
          <AlertDescription>
            <CommandText text="Return to the CLI and run `dotrelay login` or `dotrelay setup` to get a new code." />
          </AlertDescription>
        </Alert>
      );
    case "invalid":
      return (
        <Alert
          className="border-amber-300/30 bg-amber-300/5"
          data-testid="device-approval-invalid"
        >
          <Ban aria-hidden="true" className="text-amber-300" />
          <AlertTitle>This code isn&apos;t valid</AlertTitle>
          <AlertDescription>
            <CommandText text="Return to the CLI and run `dotrelay login` or `dotrelay setup` to get a new code." />
          </AlertDescription>
        </Alert>
      );
    case "forbidden":
      return (
        <Alert
          className="border-amber-300/30 bg-amber-300/5"
          data-testid="device-approval-forbidden"
        >
          <ShieldOff aria-hidden="true" className="text-amber-300" />
          <AlertTitle>
            This code can&apos;t be allowed from this sign-in
          </AlertTitle>
          <AlertDescription>
            It was claimed by a different account. Return to the CLI and check
            the code it shows.
          </AlertDescription>
        </Alert>
      );
    case "connection":
      return (
        <div className="space-y-3" data-testid="device-approval-connection">
          <Alert className="border-destructive/40">
            <WifiOff aria-hidden="true" />
            <AlertTitle>Couldn&apos;t check this code</AlertTitle>
            <AlertDescription>
              We couldn&apos;t reach the server, so we don&apos;t know this
              code&apos;s state. The code above is kept. Try again once
              you&apos;re connected.
            </AlertDescription>
          </Alert>
          <Button
            data-testid="device-approval-retry"
            disabled={busy}
            onClick={() => void checkState()}
            type="button"
          >
            Try again
          </Button>
        </div>
      );
  }
};
