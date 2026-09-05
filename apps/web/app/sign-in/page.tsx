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
              <h1>Sign in to your Server Profile</h1>
            </CardTitle>
            <CardDescription>
              Authentication establishes your server-local User. Membership and
              Device authority remain separate.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="profile-origin">Server Profile</Label>
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
              <AlertTitle>Identity is not access</AlertTitle>
              <AlertDescription>
                GitHub identifies you; it does not grant DotRelay access.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    </main>
  );
};

export default SignInPage;
