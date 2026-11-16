import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SiteShell } from "@/components/site-shell";
import { oauthErrorMessage } from "@/lib/oauth-error";
import { PRIVATE_ALPHA_PATH } from "@/lib/alpha-admission";
import { readServerSession } from "@/lib/server-session";
import {
  resolveLiveApiOrigin,
  resolveOAuthCallbackUrl,
} from "@/lib/workspace-boundary";
import { GitHubSignInButton } from "./github-sign-in-button";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to DotRelay with your GitHub account",
};

const SignInPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly error?: string }>;
}) => {
  // Read the request first so the page renders per request, and a missing
  // production API origin fails here instead of pointing sign-in at a
  // localhost the visitor doesn't run. Only development (and the explicit
  // fixture) fall back to the local API.
  const cookie = (await headers()).get("cookie");
  const liveApiOrigin = resolveLiveApiOrigin();
  const apiOrigin = liveApiOrigin ?? "http://localhost:3001";
  const { error } = await searchParams;
  // A visitor who is already signed in has nothing to do here; one the
  // alpha list doesn't admit would only sign in to the same answer.
  if (error === undefined) {
    const session = await readServerSession({
      apiOrigin: liveApiOrigin,
      cookie,
    });
    if (session === "signed-in") redirect("/workspace");
    if (session === "not-admitted") redirect(PRIVATE_ALPHA_PATH);
  }
  const callbackUrl = resolveOAuthCallbackUrl();
  const signInError = oauthErrorMessage(error);

  return (
    <SiteShell>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Sign in
      </h1>
      <p className="mt-2 text-muted-foreground">
        Use your GitHub account to continue.
      </p>
      <div className="mt-8 space-y-3">
        {signInError ? (
          <p className="text-sm text-destructive" role="alert">
            {signInError}
          </p>
        ) : null}
        <GitHubSignInButton
          apiOrigin={apiOrigin}
          callbackUrl={callbackUrl}
          errorCallbackURL={callbackUrl}
          className="h-11"
        />
      </div>
      <p className="mt-6 text-sm text-muted-foreground">
        Signing in only tells DotRelay who you are. Your values stay encrypted
        until you unlock them on one of your devices.
      </p>
    </SiteShell>
  );
};

export default SignInPage;
