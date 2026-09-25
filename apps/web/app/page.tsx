import {
  ArrowRight,
  Braces,
  Fingerprint,
  GitBranch,
  KeyRound,
} from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { resolveLiveApiOrigin } from "@/lib/workspace-boundary";

// Only a 200 from the session relay proves the visitor is signed in; a
// signed-out, unreachable, or undeployed relay all fall back to offering
// sign-in, so a degraded API never flips the landing page out of its
// public state.
const isSessionActive = async (): Promise<boolean> => {
  const apiOrigin = resolveLiveApiOrigin();
  if (!apiOrigin) return false;
  const cookie = (await headers()).get("cookie");
  const response = await fetch(`${apiOrigin}/api/v1/session`, {
    headers: cookie ? { cookie } : {},
    cache: "no-store",
  }).catch(() => undefined);
  return response?.status === 200;
};

const HomePage = async () => {
  const signedIn = await isSessionActive();
  return (
    <main className="landing-grid min-h-screen overflow-hidden">
      <nav
        aria-label="Primary navigation"
        className="mx-auto flex max-w-7xl items-center justify-between px-5 py-6 lg:px-8"
      >
        <Link
          className="flex items-center gap-3"
          href="/"
          aria-label="DotRelay home"
        >
          <span className="grid size-9 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <Braces aria-hidden="true" className="size-5" />
          </span>
          <span className="font-heading text-lg font-semibold tracking-tight">
            DotRelay
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <a
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            href="https://github.com/LSP-Software/DotRelay"
          >
            GitHub
          </a>
          <Link
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={signedIn ? "/workspace" : "/sign-in"}
          >
            {signedIn ? "Workspace" : "Sign in"}
          </Link>
        </div>
      </nav>

      <section className="relative mx-auto grid max-w-7xl gap-16 px-5 pb-20 pt-16 lg:grid-cols-[1.15fr_0.85fr] lg:px-8 lg:pb-32 lg:pt-28">
        <div className="relative z-10">
          <h1 className="max-w-3xl font-heading text-5xl font-semibold leading-[0.98] tracking-[-0.045em] sm:text-7xl">
            Share your .env files,{" "}
            <span className="text-primary">
              with your team and your machines.
            </span>
          </h1>
          <p className="mt-7 max-w-2xl text-balance text-lg leading-8 text-muted-foreground sm:text-xl">
            DotRelay keeps your project's environment variables in one place.
            Edit them in the browser or push changes with the CLI, and every
            machine you have set up gets the same values. You choose which
            teammates can access them.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link
              className={cn(
                buttonVariants({ size: "lg" }),
                "shadow-[0_0_32px_-8px_var(--primary)]",
              )}
              href={signedIn ? "/workspace" : "/sign-in"}
            >
              {signedIn ? "Open workspace" : "Get started"}{" "}
              <ArrowRight aria-hidden="true" />
            </Link>
            <a
              className={buttonVariants({ variant: "outline", size: "lg" })}
              href="#how-it-works"
            >
              How it works
            </a>
          </div>
          <div className="mt-12 flex flex-wrap gap-x-8 gap-y-3 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
            <span>CLI and browser</span>
            <span>Shared with your team</span>
            <span>Full change history</span>
          </div>
        </div>

        <div className="relative min-h-[430px]">
          <div className="signal-orbit absolute inset-6 rounded-full border border-dashed border-primary/25" />
          <Card className="absolute left-0 top-0 w-[78%] border-primary/20 bg-card/80 backdrop-blur">
            <CardHeader>
              <div className="flex items-center justify-between">
                <Badge variant="outline">Environment</Badge>
                <span className="font-mono text-[10px] text-muted-foreground">
                  REV_0184
                </span>
              </div>
              <CardTitle className="mt-3 text-xl">local</CardTitle>
              <CardDescription>Shared with your team</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 font-mono text-xs">
              {[
                ["API_ORIGIN", "••••••••••••••••"],
                ["SIGNING_KEY", "••••••••••••••••"],
                ["FEATURE_GATE", "••••••••••••••••"],
              ].map(([name, value]) => (
                <div
                  className="flex items-center justify-between rounded-md border bg-background/60 px-3 py-2"
                  key={name}
                >
                  <span>{name}</span>
                  <span className="text-primary">{value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="absolute bottom-4 right-0 w-[72%] border-primary/20 bg-card/90 backdrop-blur">
            <CardHeader>
              <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <GitBranch aria-hidden="true" />
              </div>
              <CardTitle>Every change is kept</CardTitle>
              <CardDescription>
                Each change is saved as a new revision. Roll back from the
                browser or the CLI when a value breaks something.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>

      <section className="border-y bg-card/35" id="how-it-works">
        <div className="mx-auto grid max-w-7xl lg:grid-cols-3">
          {[
            {
              icon: Fingerprint,
              step: "01 / SHARE",
              title: "Start on any machine",
              body: "Set up each machine once: sign in to the browser, or install the DotRelay CLI. After that, the machine can read and update your project's values.",
            },
            {
              icon: KeyRound,
              step: "02 / PRIVACY",
              title: "Values are encrypted on your device",
              body: "Your machine encrypts every value before it leaves, with keys that never leave it. The server stores only the encrypted form, so not even we can read your secrets.",
            },
            {
              icon: GitBranch,
              step: "03 / HISTORY",
              title: "Roll back when something breaks",
              body: "Publishing a change saves a new revision. When a value breaks your local setup, roll back to an earlier revision from the browser or the CLI.",
            },
          ].map((feature, index) => (
            <article className="p-8 lg:p-10" key={feature.title}>
              {index > 0 && <Separator className="mb-8 lg:hidden" />}
              <feature.icon
                aria-hidden="true"
                className="mb-8 size-6 text-primary"
              />
              <p className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground">
                {feature.step}
              </p>
              <h2 className="mt-4 font-heading text-xl font-medium">
                {feature.title}
              </h2>
              <p className="mt-3 leading-6 text-muted-foreground">
                {feature.body}
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
};

export default HomePage;
