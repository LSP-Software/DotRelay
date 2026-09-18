import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveLiveApiOrigin } from "@/lib/workspace-boundary";
import { WorkspaceShell } from "./workspace-shell";

export const metadata: Metadata = {
  title: "Workspace",
  description: "Manage environment variables and share secrets with your team.",
};

// Signed-out visitors are sent to the sign-in page instead of the workspace.
// Only a 401 from the session relay is authoritative "not signed in"; an
// unreachable or degraded API must not bounce signed-in users to sign-in.
const requireSignIn = async () => {
  if (process.env.DOTRELAY_WORKSPACE_FIXTURE === "1") return;
  const apiOrigin = resolveLiveApiOrigin();
  if (!apiOrigin) return;
  const cookie = (await headers()).get("cookie");
  const sessionResponse = await fetch(`${apiOrigin}/api/v1/session`, {
    headers: cookie ? { cookie } : {},
    cache: "no-store",
  }).catch(() => undefined);
  if (sessionResponse?.status === 401) redirect("/sign-in");
};

const WorkspacePage = async () => {
  await requireSignIn();
  return <WorkspaceShell />;
};

export default WorkspacePage;
