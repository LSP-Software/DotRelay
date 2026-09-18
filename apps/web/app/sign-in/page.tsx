import { Braces } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  resolveApiOrigin,
  resolveOAuthCallbackUrl,
} from "@/lib/workspace-boundary";
import { GitHubSignInButton } from "./github-sign-in-button";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to DotRelay with your GitHub account",
};

const SignInPage = () => {
  const apiOrigin = resolveApiOrigin() ?? "http://localhost:3001";
  const callbackUrl = resolveOAuthCallbackUrl();

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

        <div className="mt-9 w-full">
          <GitHubSignInButton
            apiOrigin={apiOrigin}
            callbackUrl={callbackUrl}
            className="h-11 shadow-[0_0_32px_-8px_var(--primary)]"
          />
        </div>
      </div>
    </main>
  );
};

export default SignInPage;
