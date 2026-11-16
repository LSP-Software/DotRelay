import type { ReactNode } from "react";
import { SiteShell } from "@/components/site-shell";
import { legal } from "@/lib/legal";

// Shared reading layout for the Privacy policy and Terms of service.
export const LegalDocument = ({
  title,
  children,
}: Readonly<{ readonly title: string; readonly children: ReactNode }>) => (
  <SiteShell width="reading">
    <article>
      <h1 className="font-heading text-3xl font-semibold tracking-[-0.02em]">
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Effective {legal.effectiveDate}
      </p>
      <div className="legal-prose mt-8 space-y-4 leading-7 text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_h2]:mt-10 [&_h2]:font-heading [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground [&_table]:w-full [&_table]:text-sm [&_td]:border-t [&_td]:border-border [&_td]:py-2 [&_td]:pr-3 [&_td]:align-top [&_th]:pb-2 [&_th]:pr-3 [&_th]:text-left [&_th]:text-foreground [&_ul]:space-y-1">
        {children}
      </div>
      <nav
        aria-label="Policies"
        className="mt-12 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-6 text-sm text-muted-foreground"
      >
        <a className="hover:text-foreground" href="/privacy">
          Privacy policy
        </a>
        <a className="hover:text-foreground" href="/terms">
          Terms of service
        </a>
        <a
          className="hover:text-foreground"
          href={`mailto:${legal.contactEmail}`}
        >
          {legal.contactEmail}
        </a>
      </nav>
    </article>
  </SiteShell>
);
