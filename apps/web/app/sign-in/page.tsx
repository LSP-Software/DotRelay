import { Braces, LockKeyhole, Server } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  resolveApiOrigin,
  resolveOAuthCallbackUrl,
} from "@/lib/workspace-boundary";
import { GitHubSignInButton } from "./github-sign-in-button";

const SignInPage = () => {
  const apiOrigin = resolveApiOrigin() ?? "http://localhost:3001";
  const callbackUrl = resolveOAuthCallbackUrl();

  return (
    <main className="landing-grid grid min-h-screen place-items-center px-5 py-12">
      <div className="w-full max-w-md">
        <Link className="mb-8 flex items-center justify-center gap-3" href="/">
          <span className="grid size-9 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <Braces aria-hidden="true" className="size-5" />
          </span>
          <span className="font-heading text-lg font-semibold">DotRelay</span>
        </Link>
        <Card className="border-primary/15 bg-card/90 shadow-2xl backdrop-blur">
          <CardHeader className="space-y-2">
            <div className="mb-3 grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <Server aria-hidden="true" />
            </div>
            <CardTitle className="text-2xl">
              <h1>Sign in</h1>
            </CardTitle>
            <CardDescription>
              Use your GitHub account to identify yourself on this DotRelay
              server.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="profile-origin">Server</Label>
              <div
                className="rounded-lg border bg-background/60 px-3 py-2 font-mono text-xs"
                id="profile-origin"
              >
                {apiOrigin}
              </div>
            </div>
            <GitHubSignInButton
              apiOrigin={apiOrigin}
              callbackUrl={callbackUrl}
            />
            <Alert className="border-amber-300/20 bg-amber-300/5">
              <LockKeyhole aria-hidden="true" className="text-amber-300" />
              <AlertTitle>GitHub only identifies you</AlertTitle>
              <AlertDescription>
                Signing in doesn&apos;t grant access to any project&apos;s
                values. Each machine you use still has to be set up separately.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    </main>
  );
};

export default SignInPage;
