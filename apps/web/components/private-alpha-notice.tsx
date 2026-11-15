"use client";

import { LoaderCircle, LogOut, Mail } from "lucide-react";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  alphaAccessRequestHref,
  HOSTED_SUPPORT_EMAIL,
} from "@/lib/alpha-admission";
import { cn } from "@/lib/utils";

type PrivateAlphaNoticeProps = Readonly<{
  readonly apiOrigin: string;
  readonly hosted: boolean;
  readonly className?: string;
}>;

// What a signed-in GitHub account outside the alpha list sees. Signing out
// is the only thing the API still lets that session do, so it is offered
// here for a visitor who signed in with the wrong account.
export const PrivateAlphaNotice = ({
  apiOrigin,
  hosted,
  className,
}: PrivateAlphaNoticeProps) => {
  const [signingOut, setSigningOut] = useState(false);
  const requestHref = alphaAccessRequestHref(hosted);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetch(`${apiOrigin}/api/auth/sign-out`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // The sign-in page that follows works either way.
    } finally {
      window.location.assign("/sign-in");
    }
  };

  return (
    <div
      className={cn("space-y-6", className)}
      data-testid="private-alpha-notice"
    >
      <p className="text-sm leading-6 text-muted-foreground">
        DotRelay is in private alpha — you&apos;re not on the list yet.{" "}
        {requestHref ? (
          <>
            Email{" "}
            <a
              className="font-medium text-primary underline-offset-4 hover:underline"
              href={requestHref}
            >
              {HOSTED_SUPPORT_EMAIL}
            </a>{" "}
            to request access.
          </>
        ) : (
          <>Ask this server&apos;s operator for access.</>
        )}
      </p>
      <div className="space-y-3">
        {requestHref ? (
          <a
            className={cn(buttonVariants({ size: "lg" }), "h-11 w-full")}
            data-testid="private-alpha-request"
            href={requestHref}
          >
            <Mail aria-hidden="true" />
            Request access
          </a>
        ) : null}
        <Button
          className="h-11 w-full"
          data-testid="private-alpha-sign-out"
          disabled={signingOut}
          onClick={() => void signOut()}
          size="lg"
          type="button"
          variant="outline"
        >
          {signingOut ? (
            <LoaderCircle
              aria-hidden="true"
              className="size-4 motion-safe:animate-spin"
            />
          ) : (
            <LogOut aria-hidden="true" />
          )}
          Sign out
        </Button>
        <p className="text-xs text-muted-foreground">
          Signed in with the wrong GitHub account? Sign out, then sign in with
          another.
        </p>
      </div>
    </div>
  );
};
