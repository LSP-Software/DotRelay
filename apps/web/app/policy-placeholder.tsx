import { Braces } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

// Shared body for the Privacy and Terms routes while those policies are
// written. It states that plainly and makes no policy claims of its own.
export const PolicyPlaceholder = ({
  title,
}: Readonly<{ readonly title: string }>) => (
  <main className="landing-grid grid min-h-screen place-items-center px-5 py-12">
    <div className="flex w-full max-w-md flex-col items-center text-center">
      <Link
        aria-label="DotRelay home"
        className="grid size-12 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary"
        href="/"
      >
        <Braces aria-hidden="true" className="size-6" />
      </Link>
      <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-200">
        Placeholder
      </p>
      <h1 className="mt-3 font-heading text-3xl font-semibold tracking-[-0.02em]">
        {title}
      </h1>
      <p className="mt-4 leading-7 text-muted-foreground">
        This policy is being finalised and will be published here. Until then,
        this page is a placeholder and does not describe any terms.
      </p>
      <Link
        className={buttonVariants({ variant: "outline", className: "mt-8" })}
        href="/"
      >
        Back to DotRelay
      </Link>
    </div>
  </main>
);
