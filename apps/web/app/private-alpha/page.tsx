import { Braces } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PrivateAlphaNotice } from "@/components/private-alpha-notice";
import { readServerSession } from "@/lib/server-session";
import {
  isWorkspaceFixtureEnabled,
  resolveLiveApiOrigin,
  resolveWorkspaceProfileId,
} from "@/lib/workspace-boundary";

export const metadata: Metadata = {
  title: "Private alpha",
  description: "DotRelay is in private alpha",
};

// Where the web sends a signed-in GitHub account the API answers with
// alpha_admission_required. A visitor the API admits, or who is signed out,
// has nothing to do here; an unreachable API still shows the page.
const PrivateAlphaPage = async () => {
  const cookie = (await headers()).get("cookie");
  const liveApiOrigin = resolveLiveApiOrigin();
  if (!isWorkspaceFixtureEnabled()) {
    const session = await readServerSession({
      apiOrigin: liveApiOrigin,
      cookie,
    });
    if (session === "signed-in") redirect("/workspace");
    if (session === "signed-out") redirect("/sign-in");
  }

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
          Private alpha
        </h1>
        <PrivateAlphaNotice
          apiOrigin={liveApiOrigin ?? "http://localhost:3001"}
          className="mt-3 w-full"
          hosted={resolveWorkspaceProfileId() === "hosted"}
        />
      </div>
    </main>
  );
};

export default PrivateAlphaPage;
