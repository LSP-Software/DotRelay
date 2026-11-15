import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  isAlphaAdmissionResponse,
  PRIVATE_ALPHA_PATH,
} from "@/lib/alpha-admission";
import {
  isWorkspaceFixtureEnabled,
  resolveLiveApiOrigin,
} from "@/lib/workspace-boundary";
import { WorkspaceShell } from "./workspace-shell";

export const metadata: Metadata = {
  title: "Workspace",
  description: "Manage environment variables and share secrets with your team.",
};

// Signed-out visitors are sent to the sign-in page instead of the workspace,
// and accounts outside the alpha list to the private alpha page.
// Only a 401 from the session relay is authoritative "not signed in"; an
// unreachable or degraded API must not bounce signed-in users to sign-in.
const requireSignIn = async () => {
  const cookie = (await headers()).get("cookie");
  if (isWorkspaceFixtureEnabled()) return;
  const apiOrigin = resolveLiveApiOrigin();
  if (!apiOrigin) return;
  const sessionResponse = await fetch(`${apiOrigin}/api/v1/session`, {
    headers: cookie ? { cookie } : {},
    cache: "no-store",
  }).catch(() => undefined);
  if (sessionResponse?.status === 401) redirect("/sign-in");
  if (sessionResponse && (await isAlphaAdmissionResponse(sessionResponse)))
    redirect(PRIVATE_ALPHA_PATH);
};

const WorkspacePage = async () => {
  await requireSignIn();
  return <WorkspaceShell />;
};

export default WorkspacePage;
