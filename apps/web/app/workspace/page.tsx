import type { Metadata } from "next";
import { WorkspaceShell } from "./workspace-shell";

export const metadata: Metadata = {
  title: "Workspace",
  description: "Choose a Team and Project, then view Variables",
};

const WorkspacePage = () => <WorkspaceShell />;

export default WorkspacePage;
