import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const GitHubMark = ({ className }: { readonly className?: string }) => (
  <svg
    aria-hidden="true"
    className={className}
    fill="currentColor"
    viewBox="0 0 16 16"
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

// The DotRelay mark and name, linking home. Shared by the landing page, the
// standalone pages (sign-in, private alpha, device approval, legal), and the
// workspace sidebar, so the brand reads the same everywhere.
export const BrandLink = ({ className }: { readonly className?: string }) => (
  <Link
    aria-label="DotRelay home"
    className={cn(
      "flex items-center gap-2.5 font-heading text-[17px] font-semibold",
      className,
    )}
    href="/"
  >
    <span className="grid size-7 place-items-center rounded-lg border border-primary/30 bg-primary/10 font-mono text-sm text-primary">
      {"{}"}
    </span>
    <span>DotRelay</span>
  </Link>
);

// Layout for pages outside the workspace: the same header and footer as the
// landing page around a single column of content.
export const SiteShell = ({
  children,
  width = "narrow",
}: {
  readonly children: ReactNode;
  readonly width?: "narrow" | "reading";
}) => (
  <div className="flex min-h-screen flex-col">
    <header className="border-b">
      <div className="mx-auto flex h-16 max-w-6xl items-center px-5 lg:px-8">
        <BrandLink />
      </div>
    </header>
    <main
      className={cn(
        "mx-auto w-full flex-1 px-5 py-12 sm:py-16",
        width === "narrow" ? "max-w-md" : "max-w-2xl",
      )}
    >
      {children}
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
