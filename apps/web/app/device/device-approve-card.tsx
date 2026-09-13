"use client";

import { Ban, Hourglass, ShieldOff, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { GitHubSignInButton } from "@/app/sign-in/github-sign-in-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  attemptDeviceApproval,
  checkDeviceStatus,
  checkServerProfileSession,
  type DeviceApprovalView,
  deviceApprovalAttemptView,
  deviceApprovalView,
} from "@/lib/device-approval";
import { resolveApiOrigin, resolveWebOrigin } from "@/lib/workspace-boundary";

type DeviceApproveCardProps = Readonly<{
  readonly userCode: string;
}>;

export const DeviceApproveCard = ({ userCode }: DeviceApproveCardProps) => {
  const apiOrigin = resolveApiOrigin() ?? "http://localhost:3001";
  const callbackUrl = `${resolveWebOrigin()}/device?user_code=${encodeURIComponent(userCode)}`;
  const [view, setView] = useState<"checking" | DeviceApprovalView>("checking");
  const [busy, setBusy] = useState(false);
  const runRef = useRef(0);

  const checkState = useCallback(async () => {
    const run = ++runRef.current;
    setView("checking");
    const [status, session] = await Promise.all([
      checkDeviceStatus(apiOrigin, userCode),
      checkServerProfileSession(apiOrigin),
    ]);
    if (run !== runRef.current) return;
    setView(deviceApprovalView(status, session));
  }, [apiOrigin, userCode]);

  useEffect(() => {
    void checkState();
  }, [checkState]);

  const allowCli = async () => {
    const run = ++runRef.current;
    setBusy(true);
    try {
      const attempt = await attemptDeviceApproval(apiOrigin, userCode);
      if (run !== runRef.current) return;
      const resolved = deviceApprovalAttemptView(attempt);
      if (resolved !== undefined) {
        setView(resolved);
        return;
      }
      // The code may have been processed or the session may have lapsed while
      // the request ran; re-derive the view from a fresh status check.
      setView("checking");
      const [status, session] = await Promise.all([
        checkDeviceStatus(apiOrigin, userCode),
        checkServerProfileSession(apiOrigin),
      ]);
      if (run !== runRef.current) return;
      setView(deviceApprovalView(status, session));
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
          <GitHubSignInButton apiOrigin={apiOrigin} callbackUrl={callbackUrl} />
        </div>
      );
    case "allow":
      return (
        <Button
          className="w-full"
          data-testid="device-approval-allow"
          disabled={busy}
          onClick={() => void allowCli()}
          size="lg"
          type="button"
        >
          Allow this CLI
        </Button>
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
          This CLI request was declined. You can return to the CLI.
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
            Return to the CLI and run <code>dotrelay login</code> or{" "}
            <code>dotrelay setup</code> to get a new code.
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
            Return to the CLI and run <code>dotrelay login</code> or{" "}
            <code>dotrelay setup</code> to get a new code.
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
            This code can&apos;t be allowed from this account
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
              The Server Profile could not be reached, so this code&apos;s state
              is unknown. The code above is preserved — try again once the
              connection is back.
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
