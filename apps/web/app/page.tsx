import {
  History,
  MonitorSmartphone,
  SquareTerminal,
  UserRound,
} from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { CopyableCommand } from "@/components/copyable-command";
import { InstallTabs } from "@/components/landing/install-tabs";
import { BrandLink, GitHubMark } from "@/components/site-shell";
import { buttonVariants } from "@/components/ui/button";
import { isSessionActive } from "@/lib/server-session";
import { cn } from "@/lib/utils";
import { resolveLiveApiOrigin } from "@/lib/workspace-boundary";

const REPOSITORY_URL = "https://github.com/LSP-Software/DotRelay";
const DOCS_URL = `${REPOSITORY_URL}/blob/main/docs/wiki/cli.md`;
const SECURITY_URL = `${REPOSITORY_URL}/blob/main/SECURITY.md`;

const Section = ({
  id,
  title,
  lead,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly children: ReactNode;
}) => (
  <section aria-labelledby={`${id}-title`} className="border-t py-20" id={id}>
    <div className="mx-auto max-w-6xl px-5 lg:px-8">
      <h2
        className="font-heading text-3xl font-semibold tracking-[-0.02em] sm:text-4xl"
        id={`${id}-title`}
      >
        {title}
      </h2>
      {lead ? (
        <p className="mt-3 max-w-2xl text-lg text-muted-foreground">{lead}</p>
      ) : null}
      {children}
    </div>
  </section>
);

const STEPS = [
  {
    title: "Connect the CLI",
    body: "Signs you in with GitHub and sets up this computer. Self-hosting? Add your server's address.",
    command: "dotrelay setup",
    testId: "setup-command",
  },
  {
    title: "Add your repository",
    body: "Run this in your project folder. It creates the project and a development environment.",
    command: "dotrelay init",
  },
  {
    title: "Push, then pull anywhere",
    body: "Push uploads your .env, encrypted. Teammates and your other computers pull the same values.",
    command: "dotrelay push",
  },
] as const;

const FEATURES = [
  {
    icon: MonitorSmartphone,
    title: "Keep every machine in sync",
    body: "Development, staging and production each have their own values. Pull whichever one you need.",
  },
  {
    icon: History,
    title: "Undo a bad change",
    body: "See who changed what and when. Roll back to an earlier revision from the terminal or the browser.",
  },
  {
    icon: UserRound,
    title: "Keep some values to yourself",
    body: "Mark a variable as yours only, like a local database password. Everyone sets their own value.",
  },
  {
    icon: SquareTerminal,
    title: "Use the terminal or the browser",
    body: "Edit values, invite teammates and look through history on the web. Everything also works from the CLI.",
  },
] as const;

const SERVER_VISIBILITY = [
  ["Variable values", false],
  ["Variable names and descriptions", false],
  ["Your recovery code and encryption password", false],
  ["Your GitHub username and who is on each team", true],
  ["Project, repository and environment names", true],
  ["When each change was published, and by whom", true],
] as const;

const FAQ = [
  {
    question: "Is DotRelay open source?",
    answer:
      "Yes. The server, the web app and the CLI are open source under AGPL-3.0.",
  },
  {
    question: "What happens if I lose my laptop?",
    answer:
      "Revoke it from another device or from the browser so it can't get new changes. To get back in on a new computer, approve it from a device you still have, or use the recovery code you saved.",
  },
  {
    question: "What if I lose every device and my recovery code?",
    answer:
      "Your values can't be recovered. Nobody, including us, has a copy we can decrypt. That's why you're asked to save a recovery code.",
  },
  {
    question: "What happens when I remove someone from a team?",
    answer:
      "They can't get any new changes. Anything they already pulled is still on their computer, so change those values afterwards.",
  },
  {
    question: "Can I run DotRelay on my own server?",
    answer:
      "Yes. The server and the CLI are open source. Point the CLI at your server with dotrelay setup and your server's address.",
  },
] as const;

const HomePage = async () => {
  // Read the request first so the page always renders per request (and a
  // missing production origin surfaces at request time, not prerender).
  const cookie = (await headers()).get("cookie");
  const signedIn = await isSessionActive({
    apiOrigin: resolveLiveApiOrigin(),
    cookie,
  });
  const appHref = signedIn ? "/workspace" : "/sign-in";

  return (
    <>
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
        href="#main"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
        <nav
          aria-label="Primary navigation"
          className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-5 lg:px-8"
        >
          <BrandLink className="mr-4" />
          <div className="hidden items-center gap-0.5 md:flex">
            {[
              ["How it works", "#how-it-works"],
              ["Security", "#security"],
              ["Questions", "#questions"],
            ].map(([label, href]) => (
              <a
                className={buttonVariants({ variant: "ghost", size: "sm" })}
                href={href}
                key={href}
              >
                {label}
              </a>
            ))}
            <a
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              href={DOCS_URL}
            >
              Docs
            </a>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <a
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "hidden sm:inline-flex",
              )}
              href={REPOSITORY_URL}
            >
              GitHub
            </a>
            <Link className={buttonVariants({ size: "sm" })} href={appHref}>
              {signedIn ? "Open workspace" : "Sign in"}
            </Link>
          </div>
        </nav>
      </header>

      <main id="main">
        <section className="landing-grid">
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 py-16 lg:grid-cols-2 lg:px-8 lg:py-24">
            <div className="min-w-0">
              <h1 className="font-heading text-4xl font-semibold leading-[1.05] tracking-[-0.03em] sm:text-5xl lg:text-[56px]">
                Share environment variables with your team.
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
                DotRelay keeps your <code className="font-mono">.env</code>{" "}
                values in one place and gets them onto every machine that needs
                them. Values are encrypted before they leave your computer.
              </p>
              <div className="mt-7 flex flex-wrap gap-2.5">
                <Link
                  className={cn(buttonVariants({ size: "lg" }), "h-11 px-5")}
                  href={appHref}
                >
                  {signedIn ? null : <GitHubMark className="size-4" />}
                  {signedIn ? "Open workspace" : "Sign in with GitHub"}
                </Link>
                <a
                  className={cn(
                    buttonVariants({ variant: "outline", size: "lg" }),
                    "h-11 px-5",
                  )}
                  href="#how-it-works"
                >
                  How it works
                </a>
              </div>
              {signedIn ? null : (
                <p className="mt-3.5 text-sm text-muted-foreground">
                  DotRelay is in private alpha. You can sign in once your GitHub
                  account has been let in.
                </p>
              )}
              <InstallTabs className="mt-8" />
            </div>

            <figure
              aria-label="Example terminal session"
              className="min-w-0 overflow-hidden rounded-xl border bg-[oklch(0.08_0.006_165)] shadow-2xl shadow-black/40"
            >
              <div className="flex items-center gap-2 border-b px-4 py-3 text-xs text-muted-foreground">
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="ml-2">~/acme-api</span>
              </div>
              <pre className="overflow-x-auto px-5 py-5 font-mono text-[13px] leading-7 text-foreground/90">
                <span className="text-muted-foreground">$</span> dotrelay push
                {"\n"}
                <span className="text-muted-foreground">
                  {"  changed  DATABASE_URL\n  added    STRIPE_WEBHOOK_SECRET"}
                </span>
                {"\n"}
                <span className="text-primary">✓</span> Published revision 42 to
                development{"\n\n"}
                <span className="text-muted-foreground">
                  # on a teammate&apos;s laptop
                </span>
                {"\n"}
                <span className="text-muted-foreground">$</span> dotrelay pull
                {"\n"}
                <span className="text-primary">✓</span> Updated .env from
                revision 42{"\n\n"}
                <span className="text-muted-foreground">$</span> dotrelay
                history{"\n"}
                <span className="text-muted-foreground">
                  {
                    "  42  samk     2 minutes ago\n  41  priya-n  3 days ago\n  40  jo-dev   last week"
                  }
                </span>
              </pre>
            </figure>
          </div>
        </section>

        <Section
          id="how-it-works"
          lead="Set it up once per repository. After that, it's one command to share a change and one to get it."
          title="How it works"
        >
          <ol className="mt-10 grid gap-4 lg:grid-cols-3">
            {STEPS.map((step, index) => (
              <li
                className="flex min-w-0 flex-col rounded-xl border bg-card p-6"
                key={step.title}
              >
                <p className="text-sm font-medium text-primary">
                  Step {index + 1}
                </p>
                <h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
                <p className="mt-1.5 mb-5 flex-1 text-muted-foreground">
                  {step.body}
                </p>
                <CopyableCommand
                  data-testid={"testId" in step ? step.testId : undefined}
                  value={step.command}
                />
              </li>
            ))}
          </ol>
        </Section>

        <Section id="features" title="What you can do">
          <div className="mt-10 grid overflow-hidden rounded-xl border md:grid-cols-2">
            {FEATURES.map((feature, index) => (
              <div
                className={cn(
                  "p-7",
                  index > 0 && "border-t",
                  index === 1 && "md:border-t-0",
                  index % 2 === 1 && "md:border-l",
                )}
                key={feature.title}
              >
                <feature.icon
                  aria-hidden="true"
                  className="mb-3 size-5 text-primary"
                />
                <h3 className="text-lg font-semibold">{feature.title}</h3>
                <p className="mt-1.5 text-muted-foreground">{feature.body}</p>
              </div>
            ))}
          </div>
        </Section>

        <section
          aria-labelledby="security-title"
          className="border-t py-20"
          id="security"
        >
          <div className="mx-auto grid max-w-6xl items-start gap-12 px-5 lg:grid-cols-[5fr_7fr] lg:px-8">
            <div>
              <h2
                className="font-heading text-3xl font-semibold tracking-[-0.02em] sm:text-4xl"
                id="security-title"
              >
                The server can&apos;t read your values
              </h2>
              <p className="mt-3 text-lg text-muted-foreground">
                Encryption happens on your computer. The server only stores and
                passes on encrypted data.
              </p>
              <div className="mt-6 space-y-3 text-muted-foreground">
                <p>
                  Signing in with GitHub only tells DotRelay who you are. It
                  doesn&apos;t give anyone access to your values.
                </p>
                <p>
                  DotRelay uses classical (not post-quantum) cryptography:
                  X25519, Ed25519 and AES-256-GCM. Each computer asks you to
                  confirm the server&apos;s identity the first time it connects.
                </p>
                <p>
                  <a
                    className="text-primary underline-offset-4 hover:underline"
                    href={SECURITY_URL}
                  >
                    Read the security policy
                  </a>
                </p>
              </div>
            </div>
            <table className="w-full overflow-hidden rounded-xl border text-left text-[15px]">
              <caption className="sr-only">
                What the DotRelay server can read
              </caption>
              <thead className="bg-card">
                <tr>
                  <th className="px-4 py-3 font-semibold" scope="col">
                    Data
                  </th>
                  <th className="w-36 px-4 py-3 font-semibold" scope="col">
                    Server can read it?
                  </th>
                </tr>
              </thead>
              <tbody>
                {SERVER_VISIBILITY.map(([label, readable]) => (
                  <tr className="border-t" key={label}>
                    <td className="px-4 py-3">{label}</td>
                    <td
                      className={cn(
                        "px-4 py-3 font-medium",
                        readable ? "text-muted-foreground" : "text-primary",
                      )}
                    >
                      {readable ? "Yes" : "No"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <Section id="questions" title="Questions">
          <div className="mt-8 max-w-3xl border-t">
            {FAQ.map((item) => (
              <details className="group border-b" key={item.question}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[17px] font-medium [&::-webkit-details-marker]:hidden">
                  {item.question}
                  <span
                    aria-hidden="true"
                    className="text-xl text-muted-foreground group-open:rotate-45 motion-safe:transition-transform"
                  >
                    +
                  </span>
                </summary>
                <p className="-mt-1 pb-5 text-muted-foreground">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </Section>

        <section className="border-t py-24 text-center">
          <div className="mx-auto max-w-6xl px-5 lg:px-8">
            <h2 className="font-heading text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
              Try it on one repository
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-lg text-muted-foreground">
              Install the CLI, run{" "}
              <code className="font-mono">dotrelay init</code> in a repository,
              then push.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-2.5">
              <Link
                className={cn(buttonVariants({ size: "lg" }), "h-11 px-5")}
                href={appHref}
              >
                {signedIn ? "Open workspace" : "Sign in with GitHub"}
              </Link>
              <a
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "h-11 px-5",
                )}
                href={DOCS_URL}
              >
                Read the docs
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between lg:px-8">
          <p>DotRelay</p>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
            <a className="hover:text-foreground" href={DOCS_URL}>
              Docs
            </a>
            <a className="hover:text-foreground" href={REPOSITORY_URL}>
              GitHub
            </a>
            <Link className="hover:text-foreground" href="/privacy">
              Privacy
            </Link>
            <Link className="hover:text-foreground" href="/terms">
              Terms
            </Link>
          </nav>
        </div>
      </footer>
    </>
  );
};

export default HomePage;
