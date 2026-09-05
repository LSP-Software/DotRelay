"use client";

import { GitBranch } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

type GitHubSignInButtonProps = Readonly<{
  readonly apiOrigin: string;
  readonly callbackUrl: string;
}>;

export const GitHubSignInButton = ({
  apiOrigin,
  callbackUrl,
}: GitHubSignInButtonProps) => {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const continueWithGitHub = async () => {
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`${apiOrigin}/api/auth/sign-in/social`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: callbackUrl,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        readonly url?: unknown;
        readonly detail?: unknown;
      } | null;
      if (!response.ok || typeof body?.url !== "string") {
        setError(
          typeof body?.detail === "string"
            ? body.detail
            : "GitHub sign-in could not be started.",
        );
        return;
      }
      window.location.assign(body.url);
    } catch {
      setError("GitHub sign-in could not be started.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <Button
        className="w-full"
        disabled={pending}
        onClick={() => void continueWithGitHub()}
        size="lg"
        type="button"
      >
        <GitBranch aria-hidden="true" /> Continue with GitHub
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};
