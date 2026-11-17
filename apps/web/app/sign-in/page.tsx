import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { BrandLink } from "@/components/site-shell";
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

const NEXT_STEPS = [
  {
    title: "Approve DotRelay on GitHub",
    body: "The first time, GitHub asks whether to let DotRelay know who you are.",
  },
  {
    title: "Land in your workspace",
    body: "GitHub sends you back to DotRelay, where your projects and teams are.",
  },
  {
    title: "Unlock your values in this browser",
    body: "Use your passkey, encryption password or recovery code, or approve this browser from another device. First time? You'll save a recovery code instead.",
  },
] as const;

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
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 lg:px-8">
          <BrandLink />
          <Link
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            href="/"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back to home
          </Link>
        </div>
      </header>

      <main className="landing-grid flex flex-1 items-center">
        <div className="mx-auto grid w-full max-w-5xl items-center gap-12 px-5 py-14 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-20 lg:px-8 lg:py-20">
          <section
            aria-labelledby="sign-in-title"
            className="rounded-2xl border bg-card/95 p-7 shadow-2xl shadow-black/40 sm:p-9"
          >
            <h1
              className="font-heading text-2xl font-semibold tracking-[-0.02em] sm:text-[28px]"
              id="sign-in-title"
            >
              Sign in to DotRelay
            </h1>
            <p className="mt-2 leading-relaxed text-muted-foreground">
              You sign in with GitHub. There&apos;s no separate DotRelay
              password to remember.
            </p>

            <div className="mt-8 space-y-3">
              {signInError ? (
                <p
                  className="rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive"
                  role="alert"
                >
                  {signInError}
                </p>
              ) : null}
              <GitHubSignInButton
                apiOrigin={apiOrigin}
                callbackUrl={callbackUrl}
                errorCallbackURL={callbackUrl}
                className="h-11 text-[15px]"
              />
            </div>

            <p className="mt-6 border-t pt-5 text-xs leading-5 text-muted-foreground">
              By continuing you agree to the{" "}
              <Link
                className="text-foreground underline-offset-4 hover:underline"
                href="/terms"
              >
                Terms
              </Link>{" "}
              and{" "}
              <Link
                className="text-foreground underline-offset-4 hover:underline"
                href="/privacy"
              >
                Privacy Policy
              </Link>
              .
            </p>
          </section>

          <section aria-labelledby="after-sign-in-title" className="min-w-0">
            <h2
              className="font-heading text-lg font-semibold"
              id="after-sign-in-title"
            >
              What happens next
            </h2>
            <ol className="mt-6 space-y-6">
              {NEXT_STEPS.map((step, index) => (
                <li className="flex gap-4" key={step.title}>
                  <span className="grid size-8 shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/10 font-mono text-sm text-primary">
                    {index + 1}
                  </span>
                  <div className="pt-1">
                    <p className="font-medium">{step.title}</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {step.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-8 flex gap-3 rounded-xl border bg-background/60 p-4">
              <LockKeyhole
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-primary"
              />
              <p className="text-sm leading-relaxed text-muted-foreground">
                Signing in only tells DotRelay who you are. It doesn&apos;t
                unlock anything: your values stay encrypted until you unlock
                them on one of your devices.
              </p>
            </div>
          </section>
        </div>
      </main>

      <footer className="border-t">
        <nav
          aria-label="Footer"
          className="mx-auto flex max-w-6xl flex-wrap gap-x-6 gap-y-2 px-5 py-6 text-sm text-muted-foreground lg:px-8"
        >
          <Link className="hover:text-foreground" href="/">
            Home
          </Link>
          <Link className="hover:text-foreground" href="/privacy">
            Privacy
          </Link>
          <Link className="hover:text-foreground" href="/terms">
            Terms
          </Link>
        </nav>
      </footer>
    </div>
  );
};

export default SignInPage;
