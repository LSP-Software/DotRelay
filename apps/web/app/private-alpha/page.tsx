import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SiteShell } from "@/components/site-shell";
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
    <SiteShell>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Private alpha
      </h1>
      <PrivateAlphaNotice
        apiOrigin={liveApiOrigin ?? "http://localhost:3001"}
        className="mt-2 w-full"
        hosted={resolveWorkspaceProfileId() === "hosted"}
      />
    </SiteShell>
  );
};

export default PrivateAlphaPage;
