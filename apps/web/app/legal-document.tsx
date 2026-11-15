import { Braces } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { legal } from "@/lib/legal";

// Shared reading layout for the Privacy policy and Terms of service.
export const LegalDocument = ({
  title,
  children,
}: Readonly<{ readonly title: string; readonly children: ReactNode }>) => (
  <main className="landing-grid min-h-screen px-5 py-12">
    <article className="mx-auto w-full max-w-2xl">
      <Link
        aria-label="DotRelay home"
        className="grid size-10 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary"
        href="/"
      >
        <Braces aria-hidden="true" className="size-5" />
      </Link>
      <h1 className="mt-8 font-heading text-3xl font-semibold tracking-[-0.02em]">
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Effective {legal.effectiveDate}
      </p>
      <div className="legal-prose mt-8 space-y-4 leading-7 text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_h2]:mt-10 [&_h2]:font-heading [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground [&_table]:w-full [&_table]:text-sm [&_td]:border-t [&_td]:border-border [&_td]:py-2 [&_td]:pr-3 [&_td]:align-top [&_th]:pb-2 [&_th]:pr-3 [&_th]:text-left [&_th]:text-foreground [&_ul]:space-y-1">
        {children}
      </div>
      <footer className="mt-12 border-t border-border pt-6 text-sm text-muted-foreground">
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/">Home</Link>
          <Link href="/privacy">Privacy policy</Link>
          <Link href="/terms">Terms of service</Link>
          <a href={`mailto:${legal.contactEmail}`}>{legal.contactEmail}</a>
        </nav>
      </footer>
    </article>
  </main>
);
