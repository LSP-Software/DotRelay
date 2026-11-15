import { Braces } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
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
    <main className="landing-grid grid min-h-screen place-items-center px-5 py-12">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <div className="relative">
          <div
            aria-hidden="true"
            className="absolute inset-0 scale-150 rounded-full bg-primary/15 blur-2xl"
          />
          <Link
            aria-label="DotRelay home"
            className="relative grid size-14 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary shadow-[0_0_40px_-12px_var(--primary)]"
            href="/"
          >
            <Braces aria-hidden="true" className="size-7" />
          </Link>
        </div>
        <p className="mt-4 font-heading text-base font-semibold tracking-tight">
          DotRelay
        </p>

        <h1 className="mt-14 font-heading text-3xl font-semibold tracking-[-0.02em]">
          Sign in
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Use your GitHub account to continue.
        </p>

        <div className="mt-9 w-full space-y-3">
          {signInError ? (
            <p className="text-sm text-destructive" role="alert">
              {signInError}
            </p>
          ) : null}
          <GitHubSignInButton
            apiOrigin={apiOrigin}
            callbackUrl={callbackUrl}
            errorCallbackURL={callbackUrl}
            className="h-11 shadow-[0_0_32px_-8px_var(--primary)]"
          />
        </div>
      </div>
    </main>
  );
};

export default SignInPage;
