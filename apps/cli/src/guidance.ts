/**
 * What to tell someone when a command stops, and what the CLI can do about
 * it. Interactive runs offer the fix and carry on; scripts, CI and --json
 * get the same headline and the exact next command, and never a prompt.
 */
export type Guidance = Readonly<{
  /** A plain headline: what is wrong, not an error class. */
  readonly title: string;
  /** One or two sentences on what happens next. */
  readonly explain?: string;
  /** The exact command that moves things forward. */
  readonly next?: string;
  /** A fix the CLI can run for you, when it is one you can do yourself. */
  readonly offer?: Offer;
}>;

export type Offer = Readonly<{
  /** Asked before anything runs. */
  readonly question: string;
  readonly accept: string;
  /**
   * The dotrelay command that fixes it. "setup" asks which server first;
   * "retry" runs nothing and tries the same command again.
   */
  readonly fix:
    | Readonly<{ kind: "setup" }>
    | Readonly<{ kind: "command"; args: readonly string[] }>
    | Readonly<{ kind: "retry" }>;
  /** Whether the original command runs again once the fix succeeds. */
  readonly resume: boolean;
}>;

export type GuidanceContext = Readonly<{
  /** The command that stopped, such as "pull" or "env use". */
  readonly command: string;
  /** The selected server's origin, when one is known. */
  readonly origin?: string | undefined;
  /** True when the fix will be offered, so the copy can promise to carry on. */
  readonly guided?: boolean;
  /** --no-input: the next command must work without a prompt. */
  readonly noInput?: boolean;
}>;

const hostOf = (origin: string | undefined): string => {
  if (!origin) return "the server";
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

// Commands that only report state or sign in themselves; offering to
// "carry on" with them after a sign-in would mean little.
const carriesOn = (command: string): boolean =>
  !["login", "setup", "logout", "status", "help"].includes(command);

const TRANSIENT = new Set([
  "service_unavailable",
  "request_failed",
  "rate_limit_unavailable",
  "github_unavailable",
  "transient",
]);

export const guidanceFor = (
  code: string,
  context: GuidanceContext,
): Guidance | null => {
  const host = hostOf(context.origin);
  const { command } = context;
  // Only a guided run carries on by itself after the fix.
  const thenCarryOn = (): string =>
    context.guided === true && carriesOn(command)
      ? `, then dotrelay ${command} carries on`
      : "";
  switch (code) {
    case "profile_not_selected":
      return {
        title: "DotRelay isn't set up on this machine yet",
        explain: `Connect to a server, sign in with GitHub and enroll this machine${thenCarryOn()}. If you self-host, use your own server's address.`,
        next: "dotrelay setup",
        offer: {
          question: "Set it up now?",
          accept: "Set up",
          fix: { kind: "setup" },
          resume: carriesOn(command),
        },
      };
    case "authentication_required":
    case "session_invalid":
      return {
        title: `You're signed out of ${host}`,
        explain: `Sign in with GitHub${thenCarryOn()}.`,
        next: "dotrelay login",
        offer: {
          question: "Sign in with GitHub?",
          accept: "Sign in",
          fix: { kind: "command", args: ["login"] },
          resume: carriesOn(command),
        },
      };
    case "recent_sign_in_required":
      return {
        title: "This needs a sign-in from the last ten minutes",
        explain: `This account has no active device yet. Sign in again${thenCarryOn()}.`,
        next: "dotrelay login",
        offer: {
          question: "Sign in with GitHub?",
          accept: "Sign in",
          fix: { kind: "command", args: ["login"] },
          resume: carriesOn(command),
        },
      };
    case "device_bundle_missing":
      return {
        title: `This machine isn't enrolled on ${host} yet`,
        explain: `dotrelay login signs you in with GitHub and enrolls this machine as a device${thenCarryOn()}.`,
        next: "dotrelay login",
        offer: {
          question: "Sign in and enroll this machine?",
          accept: "Sign in",
          fix: { kind: "command", args: ["login"] },
          resume: carriesOn(command),
        },
      };
    case "account_key_not_unlocked":
      return {
        title: "This device can't read values yet",
        explain: `It needs your account key, sent from a device or browser you already use, or opened with your recovery code${thenCarryOn()}.`,
        next: context.noInput
          ? "dotrelay device recover --recovery-code-file <path>"
          : "dotrelay device recover",
        offer: {
          question: "Get your account key now?",
          accept: "Get it",
          fix: { kind: "command", args: ["device", "recover"] },
          resume: carriesOn(command),
        },
      };
    case "device_not_active":
      return {
        title: "This device is no longer active",
        explain:
          "It was revoked or replaced. Enroll it again and approve it from a device you still use.",
        next: "dotrelay device enroll",
      };
    case "device_proof_required":
      return {
        title: `${host} didn't accept this device's key`,
        explain: "Try again. If it keeps failing, sign in again.",
        next: "dotrelay login",
        offer: {
          question: "Try again?",
          accept: "Retry",
          fix: { kind: "retry" },
          resume: true,
        },
      };
    case "project_not_linked":
      return {
        title: "This repository isn't linked to a project you can access",
        explain:
          "If a teammate already published it, ask a team owner or admin to invite you and share the project keys. To publish this repo's .env as a new project yourself, run dotrelay init.",
        next: "dotrelay init",
        ...(command === "pull" || command === "diff" || command === "run"
          ? {
              offer: {
                question: "Publish this repo's .env as a new project?",
                accept: "Publish",
                fix: { kind: "command", args: ["init"] },
                resume: false,
              },
            }
          : {}),
      };
    case "membership_not_key_provisioned":
    case "membership_pending":
    case "membership_not_active":
      // The detail names the Team and the exact steps, so it is shown
      // instead of a general explanation.
      return { title: "Waiting for a teammate to share the project keys" };
    // The publish may already have landed. Running the command again checks
    // the earlier attempt before it publishes anything new, so a retry is
    // safe; "nothing changed" would not be.
    case "publication_uncertain":
      return {
        title: "Not sure whether your publish went through",
        explain:
          "The connection dropped before the server confirmed it. Running the command again checks the earlier attempt before it publishes anything new.",
        offer: {
          question: "Check and try again?",
          accept: "Check",
          fix: { kind: "retry" },
          resume: true,
        },
      };
    case "rate_limited":
      return { title: `${host} is rate-limiting requests` };
    case "repository_missing":
      return {
        title: "No GitHub remote in this repository",
        explain:
          "DotRelay finds the project from the repository's GitHub remote. Add one, or run this from a clone of the repository.",
      };
    default:
      break;
  }
  if (TRANSIENT.has(code))
    return {
      title:
        code === "github_unavailable"
          ? "GitHub couldn't be reached"
          : code === "request_failed"
            ? `${host} couldn't finish the request`
            : `Couldn't reach ${host}`,
      // The request may have failed after the server acted on it, so the
      // copy promises nothing about what changed.
      explain:
        code === "github_unavailable"
          ? "Projects that are already linked still sync. Try again once GitHub is back."
          : code === "service_unavailable"
            ? "Check your connection, then try again."
            : "Try again in a moment.",
      offer: {
        question: "Try again?",
        accept: "Retry",
        fix: { kind: "retry" },
        resume: true,
      },
    };
  return null;
};

/** The next command for --json and other scripted output, if there is one. */
export const nextCommandFor = (
  code: string,
  context: GuidanceContext,
): string | undefined => guidanceFor(code, context)?.next;
