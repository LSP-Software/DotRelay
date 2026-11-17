"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GitHubMark } from "@/components/site-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type GitHubSignInButtonProps = Readonly<{
  readonly apiOrigin: string;
  readonly callbackUrl: string;
  readonly errorCallbackURL?: string;
  readonly className?: string;
  /** Start the GitHub sign-in as soon as the button mounts. */
  readonly autoStart?: boolean;
}>;

export const GitHubSignInButton = ({
  apiOrigin,
  callbackUrl,
  errorCallbackURL,
  className,
  autoStart = false,
}: GitHubSignInButtonProps) => {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(autoStart);
  const autoStarted = useRef(false);

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
          ...(errorCallbackURL ? { errorCallbackURL } : {}),
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

  // Starts once, on mount; the ref stops React's development double run.
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void continueWithGitHub();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on mount
  }, []);

  return (
    <div className="space-y-3">
      <Button
        className={cn("w-full", className)}
        disabled={pending}
        onClick={() => void continueWithGitHub()}
        size="lg"
        type="button"
      >
        {pending ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-4 motion-safe:animate-spin"
          />
        ) : (
          <GitHubMark className="size-4" />
        )}
        Continue with GitHub
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};
