import { Braces, GitBranch, LockKeyhole, Server } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";

const SignInPage = () => {
  const apiOrigin =
    process.env.NEXT_PUBLIC_DOTRELAY_API_ORIGIN ?? "http://localhost:3001";

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
            <form action={`${apiOrigin}/api/auth/sign-in/social`} method="post">
              <input name="provider" type="hidden" value="github" />
              <input name="callbackURL" type="hidden" value="/workspace" />
              <Button className="w-full" size="lg" type="submit">
                <GitBranch aria-hidden="true" /> Continue with GitHub
              </Button>
            </form>
            <Alert className="border-amber-300/20 bg-amber-300/5">
              <LockKeyhole aria-hidden="true" className="text-amber-300" />
              <AlertTitle>Identity is not access</AlertTitle>
              <AlertDescription>
                GitHub identifies you; it does not grant DotRelay access.
              </AlertDescription>
            </Alert>
            <Link
              className="block text-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              href="/workspace"
            >
              Explore the non-secret demo workspace
            </Link>
          </CardContent>
        </Card>
      </div>
    </main>
  );
};

export default SignInPage;
