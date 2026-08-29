import type { Metadata } from "next";
import { WorkspaceShell } from "./workspace-shell";

export const metadata: Metadata = {
  title: "Workspace",
  description: "DotRelay Team, Project, and Environment workspace",
};

const WorkspacePage = () => <WorkspaceShell />;

export default WorkspacePage;
