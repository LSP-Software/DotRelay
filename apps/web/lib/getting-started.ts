// First-run checklist for a signed-in browser. GitHub sign-in only
// identifies the user: a team still comes from `dotrelay init` (or an
// invitation), and this browser still needs its own trust decision and
// device keys. The checklist is the projects landing until those are done.
// Dismissal is per user, in this browser, and only applies once a team
// exists — with no team the checklist is the only next action.

export const CLI_PACKAGE_MANAGERS = ["npm", "yarn", "pnpm", "bun"] as const;

export type CliPackageManager = (typeof CLI_PACKAGE_MANAGERS)[number];

const CLI_INSTALL_COMMANDS: Record<CliPackageManager, string> = {
  npm: "npm install -g dotrelay@latest",
  yarn: "yarn global add dotrelay",
  pnpm: "pnpm add -g dotrelay",
  bun: "bun add -g dotrelay",
};

export const cliInstallCommand = (manager: CliPackageManager): string =>
  CLI_INSTALL_COMMANDS[manager];
export const CLI_INIT_COMMAND = "dotrelay init";

export const gettingStartedDismissedKey = (userId: string): string =>
  `dotrelay.getting-started.dismissed:${userId}`;

export const readGettingStartedDismissed = (userId: string): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(gettingStartedDismissedKey(userId)) === "1"
    );
  } catch {
    return false;
  }
};

export const writeGettingStartedDismissed = (
  userId: string,
  dismissed: boolean,
): void => {
  if (typeof window === "undefined") return;
  try {
    const key = gettingStartedDismissedKey(userId);
    if (dismissed) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Dismissal is a preference. A storage failure leaves the checklist up.
  }
};

// The package manager this machine installs the CLI with is a property of
// the machine, not of one signed-in user, so the key is not user-scoped.
export const cliPackageManagerKey = "dotrelay.getting-started.package-manager";

export const readCliPackageManager = (): CliPackageManager => {
  if (typeof window === "undefined") return "npm";
  try {
    const stored = window.localStorage.getItem(cliPackageManagerKey);
    return stored !== null &&
      (CLI_PACKAGE_MANAGERS as readonly string[]).includes(stored)
      ? (stored as CliPackageManager)
      : "npm";
  } catch {
    return "npm";
  }
};

export const writeCliPackageManager = (manager: CliPackageManager): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(cliPackageManagerKey, manager);
  } catch {
    // The choice is a display preference; a storage failure still applies
    // it for this session.
  }
};

export type GettingStartedStepId = "cli" | "team" | "browser" | "recovery";

export type GettingStartedStepStatus = "done" | "current" | "later";

export type GettingStartedInput = Readonly<{
  sessionActive: boolean;
  profileTrusted: boolean;
  cryptoAvailable: boolean;
  browserEnrolled: boolean;
  recoveryConfigured: boolean;
  teamCount: number;
  otherDeviceCount: number;
  dismissed: boolean;
}>;

export type GettingStartedStep = Readonly<{
  id: GettingStartedStepId;
  status: GettingStartedStepStatus;
}>;

export type GettingStartedModel = Readonly<{
  visible: boolean;
  resumable: boolean;
  steps: readonly GettingStartedStep[];
}>;

const stepDone = (
  input: GettingStartedInput,
  id: GettingStartedStepId,
): boolean => {
  switch (id) {
    case "cli":
      return input.otherDeviceCount > 0;
    case "team":
      return input.teamCount > 0;
    case "browser":
      return input.browserEnrolled;
    case "recovery":
      return input.recoveryConfigured;
    default: {
      const unreachable: never = id;
      return unreachable;
    }
  }
};

export const buildGettingStarted = (
  input: GettingStartedInput,
): GettingStartedModel => {
  const hasTeam = input.teamCount > 0;
  // A team already exists (CLI init, or an accepted invitation), so the
  // browser path is trust then this browser's own keys. With no team, the
  // CLI has to create one before this browser has anything to read.
  const order: readonly GettingStartedStepId[] = hasTeam
    ? ["browser", "recovery"]
    : ["cli", "recovery", "team", "browser"];
  const requiredDone =
    input.profileTrusted &&
    input.browserEnrolled &&
    input.recoveryConfigured &&
    hasTeam;
  const eligible = input.sessionActive && input.cryptoAvailable;
  const canDismiss = input.dismissed && hasTeam && input.recoveryConfigured;
  const visible = eligible && !requiredDone && !canDismiss;
  const resumable = eligible && !requiredDone && canDismiss;
  let currentAssigned = false;
  const steps: GettingStartedStep[] = order.map((id) => {
    if (stepDone(input, id)) return { id, status: "done" };
    if (!currentAssigned) {
      currentAssigned = true;
      return { id, status: "current" };
    }
    return { id, status: "later" };
  });
  return {
    visible,
    resumable,
    steps: visible ? steps : [],
  };
};
