"use client";

import { useState } from "react";
import { CopyableCommand } from "@/components/copyable-command";
import { cn } from "@/lib/utils";

const SCRIPTS_URL =
  "https://raw.githubusercontent.com/LSP-Software/DotRelay/main/scripts";

const INSTALL_OPTIONS = [
  {
    id: "unix",
    label: "macOS / Linux",
    command: `curl -fsSL ${SCRIPTS_URL}/install.sh | sh`,
  },
  {
    id: "windows",
    label: "Windows",
    command: `irm ${SCRIPTS_URL}/install.ps1 | iex`,
  },
  { id: "npm", label: "npm", command: "npm install -g @dotrelay/cli" },
] as const;

type InstallOption = (typeof INSTALL_OPTIONS)[number]["id"];

export const InstallTabs = ({ className }: { readonly className?: string }) => {
  const [selected, setSelected] = useState<InstallOption>("unix");
  const option =
    INSTALL_OPTIONS.find((candidate) => candidate.id === selected) ??
    INSTALL_OPTIONS[0];

  return (
    <div className={cn("max-w-xl", className)}>
      <div
        aria-label="Install the CLI"
        className="flex gap-1 border-b border-border"
        role="tablist"
      >
        {INSTALL_OPTIONS.map((candidate) => (
          <button
            aria-controls="install-panel"
            aria-selected={candidate.id === selected}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              candidate.id === selected
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            id={`install-tab-${candidate.id}`}
            key={candidate.id}
            onClick={() => setSelected(candidate.id)}
            role="tab"
            type="button"
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`install-tab-${option.id}`}
        className="pt-3"
        id="install-panel"
        role="tabpanel"
      >
        <CopyableCommand data-testid="install-command" value={option.command} />
      </div>
    </div>
  );
};
