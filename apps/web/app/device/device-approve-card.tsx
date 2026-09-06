"use client";

import { useEffect, useState } from "react";
import { GitHubSignInButton } from "@/app/sign-in/github-sign-in-button";
import { Button } from "@/components/ui/button";
import { resolveApiOrigin, resolveWebOrigin } from "@/lib/workspace-boundary";

type DeviceApproveCardProps = Readonly<{
  readonly userCode: string;
}>;

type DeviceStatus = "loading" | "sign-in" | "allow" | "approved" | "failed";

export const DeviceApproveCard = ({ userCode }: DeviceApproveCardProps) => {
  const apiOrigin = resolveApiOrigin() ?? "http://localhost:3001";
  const callbackUrl = `${resolveWebOrigin()}/device?user_code=${encodeURIComponent(userCode)}`;
  const [status, setStatus] = useState<DeviceStatus>("loading");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const readStatus = async () => {
      try {
        const response = await fetch(
          `${apiOrigin}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
          { credentials: "include", cache: "no-store" },
        );
        const body = (await response.json().catch(() => null)) as {
          readonly status?: unknown;
        } | null;
        if (cancelled) return;
        if (response.ok && body?.status === "pending") {
          setStatus("allow");
          return;
        }
        setStatus("sign-in");
      } catch {
        if (!cancelled) setStatus("sign-in");
      }
    };
    void readStatus();
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, userCode]);

  const allowCli = async () => {
    setPending(true);
    try {
      const response = await fetch(`${apiOrigin}/api/auth/device/approve`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode }),
      });
      setStatus(response.ok ? "approved" : "failed");
    } catch {
      setStatus("failed");
    } finally {
      setPending(false);
    }
  };

  if (status === "loading")
    return <p className="text-sm text-muted-foreground">Checking this code…</p>;

  if (status === "approved")
    return (
      <p className="text-sm text-primary" role="status">
        Allowed. You can return to the CLI.
      </p>
    );

  if (status === "failed")
    return (
      <p className="text-sm text-destructive" role="alert">
        This CLI could not be allowed. Request a new code and try again.
      </p>
    );

  if (status === "allow")
    return (
      <Button
        className="w-full"
        disabled={pending}
        onClick={() => void allowCli()}
        size="lg"
        type="button"
      >
        Allow this CLI
      </Button>
    );

  return <GitHubSignInButton apiOrigin={apiOrigin} callbackUrl={callbackUrl} />;
};
