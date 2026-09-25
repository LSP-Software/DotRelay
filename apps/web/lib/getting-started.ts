// First-run checklist for a signed-in browser. GitHub sign-in only
// identifies the user: a team still comes from `dotrelay init` (or an
// invitation), and this browser still needs its own trust decision and
// device keys. The checklist is the projects landing until those are done.
// Dismissal is per user, in this browser, and only applies once a team
// exists — with no team the checklist is the only next action.

export const CLI_INSTALL_COMMAND = "npm install -g dotrelay@latest";
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

export type GettingStartedStepId = "trust" | "cli" | "team" | "browser";

export type GettingStartedStepStatus = "done" | "current" | "later";

export type GettingStartedInput = Readonly<{
  sessionActive: boolean;
  profileTrusted: boolean;
  cryptoAvailable: boolean;
  browserEnrolled: boolean;
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
    case "trust":
      return input.profileTrusted;
    case "cli":
      return input.otherDeviceCount > 0;
    case "team":
      return input.teamCount > 0;
    case "browser":
      return input.browserEnrolled;
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
    ? ["trust", "browser"]
    : ["trust", "cli", "team", "browser"];
  const requiredDone = input.profileTrusted && input.browserEnrolled && hasTeam;
  const eligible = input.sessionActive && input.cryptoAvailable;
  const visible = eligible && !requiredDone && !(input.dismissed && hasTeam);
  const resumable = eligible && !requiredDone && input.dismissed && hasTeam;
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
