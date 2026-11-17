import {
  COMMANDS,
  type CommandName,
  FLAG_KEYS,
  FLAG_PERMISSIONS,
  FLAG_TOKENS,
  type FlagKey,
  SUBCOMMANDS,
  usageForLabel,
} from "./args";
import { banner, bold, paint, section } from "./components";
import { CliInvocationError } from "./errors";
import { HOSTED_ORIGIN } from "./hosted-origin";
import { defaultOrigin } from "./version";

export type CommandHelpEntry = Readonly<{
  readonly about: string;
  readonly positional?: readonly string[];
  readonly options?: Readonly<Partial<Record<FlagKey, string>>>;
  readonly notes?: readonly string[];
  readonly examples: readonly string[];
}>;

// The per-command help data. Keys are the same command labels the parser
// uses (see USAGE and FLAG_PERMISSIONS in args.ts), so a command that exists
// for the parser must exist here and vice versa; the contract tests in
// help.test.ts keep the two in lockstep.
const ORIGIN_ARGUMENT =
  "<origin>  The server's address. Without a scheme, https is used.";
const NO_INPUT_WITH_CONTEXT =
  "never prompt or guess. Pass --profile, and name the environment or have one saved";
const CLASSIFY =
  "set who owns a new variable: shared (Team) or user-defined (Only me). With --no-input, every new variable needs one";
const TRANSFER_CODE =
  "the transfer code the sending device printed: the transfer id, a dot, and the account fingerprint this device checks";

export const COMMAND_HELP: Readonly<Record<string, CommandHelpEntry>> = {
  setup: {
    about:
      "Connect to a DotRelay server, sign in with GitHub, and enroll this machine as a device. The server's identity is saved, and later runs check that it hasn't changed.",
    positional: [ORIGIN_ARGUMENT],
    options: {
      noInput: "never ask for input",
      noOpen: "don't open the verification page in a browser",
    },
    notes: [
      "If a saved server's identity has changed, setup stops. Find out why it changed before you continue.",
      "For a loopback host such as localhost, setup retries once over plain HTTP if HTTPS can't be reached.",
      "The hosted service is at https://api.dotrelay.dev. If you self-host, use your own server's API address.",
    ],
    examples: [
      "dotrelay setup https://api.dotrelay.dev",
      "dotrelay setup relay.example",
      "dotrelay setup https://relay.example --no-input",
    ],
  },
  login: {
    about:
      "Sign in with GitHub and enroll this machine. GitHub only proves who you are. On a new machine joining an existing account, login also asks for your recovery code to unlock the account key. The verification URL, the code, and when the code expires are shown before the CLI starts waiting.",
    options: {
      profile: "server profile to sign in to (default: the selected profile)",
      noInput:
        "never prompt or open a browser. The URL, code, and expiry are printed so you can open the page yourself",
    },
    examples: ["dotrelay login", "dotrelay login --profile work --no-open"],
  },
  logout: {
    about:
      "Sign out of the server. If the server can be reached, it revokes the session. The local copy is always deleted from the credential store. This device stays enrolled.",
    notes: [
      "If the server can't be reached, the local session is still removed, and the result says the server-side session wasn't revoked. That session expires on its own.",
    ],
    examples: ["dotrelay logout", "dotrelay logout --profile work"],
  },
  init: {
    about:
      "Publish this repository's .env for the first time. If the GitHub repository isn't linked yet, init creates whichever team, project, and environment are missing. If the environment already has its first revision, init carries on as push.",
    positional: [
      "<environment-id-or-label>  Optional. The environment to publish to. Defaults to the saved selection, or the project's only active environment.",
    ],
    options: {
      from: "dotenv file to publish (default: .env)",
      classify: CLASSIFY,
      environment:
        "environment id or label to publish to (instead of the positional)",
      team: "team to link the repository to (default: your only team, one you pick, or a new one)",
      noInput: NO_INPUT_WITH_CONTEXT,
      force: "approve removing variables that the file leaves out",
    },
    notes: [
      "In a project created during this run, a label that doesn't exist yet becomes the first environment's label. In an existing project, create the environment first with dotrelay env create <label>.",
    ],
    examples: [
      "dotrelay init",
      "dotrelay init production --classify API_URL=shared",
      "dotrelay init <environment-id>",
    ],
  },
  push: {
    about:
      "Publish changes from .env, or the file you pass with --from, to the environment. Variables missing from the file are removed from the environment. You confirm only the variables that change, and their values are masked unless you ask to see them.",
    options: {
      from: "dotenv file to publish (default: .env)",
      classify: CLASSIFY,
      environment:
        "environment id or label to publish to (default: the saved selection, or the project's only active environment)",
      team: "team to link the repository to (default: your only team, one you pick, or a new one)",
      noInput: NO_INPUT_WITH_CONTEXT,
      force: "approve removing variables that the file leaves out",
    },
    examples: [
      "dotrelay push",
      "dotrelay push --from .env --classify NEW_VARIABLE=user-defined",
      "dotrelay push --environment <environment-id>",
    ],
  },
  run: {
    about:
      "Decrypt the environment in memory and start a command with its values set as environment variables. Nothing is written to disk. dotrelay exits with the command's exit code, and passes Ctrl-C and termination signals on to it.",
    positional: [
      "<command> [<argument>…]  The command to start and its arguments, after --.",
    ],
    options: {
      environment:
        "environment id or label to load (default: this worktree's selection)",
      allowEnv:
        "let through a variable that controls how programs or shells start, such as NODE_OPTIONS or PATH. Repeat for more",
      noInput: NO_INPUT_WITH_CONTEXT,
    },
    notes: [
      "Values from the environment replace variables with the same name that are already set in your shell.",
      "Everything after -- belongs to the command, so dotrelay never reads its flags.",
      "If a required variable has no value, or this device can't decrypt a value, dotrelay stops before the command starts.",
      "dotrelay also stops if a variable controls how programs, shells, or build tools start (PATH, NODE_OPTIONS, LD_*, DYLD_*, BASH_ENV, PYTHON*, GIT_*, GOFLAGS, CC, CXX, CGO_*, RUSTC_WRAPPER, BROWSER, XDG_* and similar). Any member of the team can set one, so you have to name each one with --allow-env.",
    ],
    examples: [
      "dotrelay run -- npm start",
      "dotrelay run --environment production -- ./deploy.sh",
      "dotrelay run --profile ci --environment staging --no-input -- npm test",
      "dotrelay run --allow-env NODE_OPTIONS -- node app.js",
    ],
  },
  export: {
    about:
      "Print the decrypted values to stdout as dotenv lines, a JSON object, or shell export statements. Nothing is written to disk. To print to a terminal, add --reveal.",
    options: {
      format: "output format: dotenv (default), json, or shell",
      environment:
        "environment id or label to export (default: this worktree's selection)",
      reveal: "allow printing the values to a terminal",
      allowEnv:
        "with --format shell, print a variable that controls how programs or shells start. Repeat for more",
      noInput: NO_INPUT_WITH_CONTEXT,
    },
    notes: [
      "--format json prints the values themselves. It's a data format, not the --json flag, whose output never contains values.",
      "--format shell won't print variables that control how programs or shells start (PATH, NODE_OPTIONS, LD_*, BASH_ENV and similar) unless you name each one with --allow-env.",
    ],
    examples: [
      "dotrelay export",
      "dotrelay export --format json",
      "dotrelay export --format shell --reveal",
    ],
  },
  list: {
    about:
      "List the environment's variables by name, with who owns each one (Team or Only me) and whether this device has a value for it. Values are never shown.",
    options: {
      environment:
        "environment id or label to list (default: this worktree's selection)",
      noInput: NO_INPUT_WITH_CONTEXT,
    },
    examples: ["dotrelay list", "dotrelay list --environment production"],
  },
  pull: {
    about:
      "Write the decrypted values to .env, or the file you name. Before it writes anything, pull checks the file in Git. It refuses a file that Git tracks, and adds an untracked one to the repository's .git/info/exclude.",
    options: {
      output: "file to write (default: .env)",
      stdout:
        "write the values to stdout instead of a file. A terminal also needs --reveal",
      environment:
        "environment id or label to pull from (default: this worktree's selection)",
      force:
        "with --no-input, approve replacing an output file that differs. The old file is kept at <path>.previous",
      discardLocal:
        "with --force, also throw away local changes you made since the last pull and never pushed",
      noInput: NO_INPUT_WITH_CONTEXT,
    },
    notes: [
      "You can't use --stdout and --output together.",
      "Values never appear in JSON output. dotrelay pull --output <file> --json prints a summary without them.",
    ],
    examples: [
      "dotrelay pull",
      "dotrelay pull --output .env",
      "dotrelay pull -o .env.local",
      "dotrelay pull --stdout --reveal",
    ],
  },
  diff: {
    about:
      "Compare .env, or the file you pass with --from, with the environment. It lists the added, changed, and removed variables by name, owner, and kind of change, without their values.",
    options: {
      from: "dotenv file to compare (default: .env)",
      environment:
        "environment id or label to compare with (default: this worktree's selection)",
      reveal:
        "show the full value diff for this one run instead of the masked summary",
    },
    examples: ["dotrelay diff", "dotrelay diff --from .env.local"],
  },
  update: {
    about:
      "Install the newest version of dotrelay. It stays on the track you installed: a stable release follows the npm latest tag, a dev build follows the dev tag, and a prerelease such as an alpha follows its own tag until its stable release is out. A copy installed with npm or bun is updated by that package manager. A standalone binary is replaced with the release from GitHub after its SHA-256 checksum is checked.",
    notes: [
      "Once a day, other commands check for a newer version in the background and say when one is out. The check is skipped with --json, --no-input, in CI, and when DOTRELAY_NO_UPDATE_CHECK=1 is set.",
      "A copy installed inside a project is updated through that project's package manager instead.",
    ],
    examples: ["dotrelay update", "dotrelay update --json"],
  },
  status: {
    about:
      "Show how this machine is connected: the server, your session, this device, and what to fix next. Lines that come from saved state say so. Only lines the server has confirmed call the session or device current.",
    examples: ["dotrelay status"],
  },
  context: {
    about:
      "Find the GitHub repository for this worktree from its Git remotes, and look up the repository's numeric GitHub id, which never changes. If you pick a remote with --remote, it's saved for this worktree only after the command succeeds.",
    options: {
      environment:
        "environment selection to show (default: this worktree's selection)",
      noInput:
        "never prompt. If more than one remote could match, the error lists the --remote choices",
    },
    examples: ["dotrelay context"],
  },
  "context reselect": {
    about:
      "Clear an outdated project or environment selection in this worktree. Device keys and trusted revision history aren't touched. If the context file is invalid, it's backed up before it's removed.",
    options: {
      noInput: "never prompt. Needs --force to approve the change",
      force: "clear the selection without asking",
    },
    examples: ["dotrelay context reselect"],
  },
  history: {
    about:
      "List the environment's verified revisions with readable dates, what changed in each one, and a #number for each. history --json keeps the documented revision metadata for scripts.",
    examples: ["dotrelay history", "dotrelay history --limit 25"],
  },
  rollback: {
    about:
      "Set the variables you pick back to the values they had in an earlier revision. This adds a new rollback revision that changes only those variables. Earlier history is never rewritten or removed, and every other value stays as it is.",
    positional: [
      "<revision-id-or-ordinal>  The #number from dotrelay history, or the revision's id. Leave it out to pick from the history. Required with --no-input.",
    ],
    options: {
      variable:
        "variable to roll back, by name or id. Repeat it for more than one. Required with --no-input.",
      environment:
        "environment id or label to roll back in (default: this worktree's selection)",
      reveal:
        "show the full value diff in the final review instead of the masked summary",
    },
    notes: [
      "With --no-input, pass --profile, the target revision, and at least one --variable. The environment must be named or already saved.",
    ],
    examples: [
      "dotrelay history",
      "dotrelay rollback 3 --variable DATABASE_URL",
      "dotrelay rollback <revision-id> --variable <variable-id>",
    ],
  },
  help: {
    about:
      "Show the list of commands, or the usage, arguments, options, and examples for one command. dotrelay <command> --help shows the same page.",
    positional: [
      "<command>  A command such as rollback, or a subcommand such as device recover.",
    ],
    examples: [
      "dotrelay help",
      "dotrelay help rollback",
      "dotrelay help device recover",
    ],
  },
  "profile add": {
    about:
      "Save a server profile. Later visits check that the server's identity hasn't changed.",
    positional: ["<name>  A local name for the profile.", ORIGIN_ARGUMENT],
    options: {
      noInput: "never ask for input",
    },
    examples: ["dotrelay profile add work https://relay.example"],
  },
  "profile use": {
    about:
      "Choose the server profile that commands use when you don't pass --profile.",
    positional: ["<name>  The name of a saved profile."],
    examples: ["dotrelay profile use work"],
  },
  "profile list": {
    about: "List your saved server profiles and mark the selected one.",
    examples: ["dotrelay profile list"],
  },
  "profile rebind": {
    about:
      "Point a saved server profile at a server that moved to a new address or was restored. The command shows the old and new address and server identity. Device keys are kept. Trusted revision history is reset only for environments whose history no longer verifies.",
    positional: [
      "<name>  The name of a saved profile.",
      "<origin>  The new address to pin. Without a scheme, https is used.",
    ],
    options: {
      noInput: "never prompt. Needs --force to approve the rebind",
      force: "rebind without asking",
    },
    examples: ["dotrelay profile rebind work https://relay.example"],
  },
  "device enroll": {
    about:
      "Enroll this machine as your first device. If your account already has an enrolled device, this starts an enrollment request instead, and you approve it from that device.",
    options: {
      output: "file to write the signed enrollment request to",
      profile: "server profile to enroll on (required with --no-input)",
      noInput: "never prompt. Needs --profile",
    },
    examples: ["dotrelay device enroll"],
  },
  "device begin": {
    about:
      "Start enrolling this machine and write a signed request file for one of your other devices to approve. The file holds only public data.",
    options: {
      output: "request file to write",
      profile: "server profile to enroll on (required with --no-input)",
      noInput: "never prompt. Needs --profile",
    },
    examples: ["dotrelay device begin --output enrollment-request.json"],
  },
  "device approve": {
    about:
      "Approve an enrollment request from a second device that's already authorized, using the signed request file.",
    options: {
      from: "signed request file to approve (required)",
      profile: "server profile to enroll on (required with --no-input)",
      noInput: "never prompt. Needs --profile",
    },
    examples: ["dotrelay device approve --from enrollment-request.json"],
  },
  "device complete": {
    about:
      "Finish an approved enrollment on the device that started it, once the approved request file comes back.",
    options: {
      from: "approved request file to finish with (required)",
      profile: "server profile to enroll on (required with --no-input)",
      noInput: "never prompt. Needs --profile",
    },
    examples: ["dotrelay device complete --from enrollment-request.json"],
  },
  "device backup": {
    about:
      "Create a recovery code that unlocks your account key. The code is 13 groups of 4 characters, printed once as the only output. It's the only way to recover on a headless machine, because passkeys and the encryption password need a browser.",
    notes: [
      "This device must already hold the account key. If it doesn't, run dotrelay device recover first.",
      "A new recovery code replaces the old one, which stops working. Store the new one somewhere safe.",
    ],
    options: {
      profile: "server profile to back up (required with --no-input)",
      noInput: "never prompt. Needs --profile",
    },
    examples: ["dotrelay device backup"],
  },
  "device recover": {
    about:
      "Unlock this device by recovering your account key. Use a recovery code typed on this machine, or a transfer from a device or browser that already has the key.",
    notes: [
      "You type the recovery code at a hidden prompt, pipe it on stdin, or pass a file with --recovery-code-file <path>. It never goes on the command line and is never sent to the server.",
      "--no-input never prompts, so pass --recovery-code-file or --transfer. With --no-input, --transfer needs the whole transfer code, not just the transfer id.",
      "To unlock with a passkey or your encryption password, use a browser. The browser then sends the key to this machine as a transfer.",
    ],
    options: {
      recoveryCodeFile:
        "path to a file with mode 0600 that holds the recovery code (13 groups of 4 characters). Meant for scripts",
      transfer: TRANSFER_CODE,
      profile: "server profile to recover on (required with --no-input)",
      noInput: "never prompt. Needs --profile",
    },
    examples: [
      "dotrelay device recover",
      "dotrelay device recover --recovery-code-file <path-to-code>",
      "dotrelay device recover --transfer <transfer-code>",
    ],
  },
  "device setup": {
    about:
      "Create your account key (the Account Master Key) on a newly enrolled device. The command generates the key, creates the recovery code you must have, and stores the key on this device. It's safe to run again. If this device already holds the key, it does nothing. If your account already has a key, it tells you to recover that one instead.",
    notes: [
      "The recovery code is printed once. It's the only lasting way to recover on a headless machine, so store it somewhere safe.",
      "If this server has no session yet, run dotrelay login first.",
    ],
    options: {
      profile: "server profile to set up (required with --no-input)",
      noInput: "never prompt. Needs --profile",
    },
    examples: ["dotrelay device setup"],
  },
  "device transfer": {
    about:
      "Send this device's account key to another active device on your account. The key is sealed to the receiving device's key and published as a one-time transfer. The receiving device accepts it with dotrelay device recover --transfer <transfer-code>. This device keeps its own copy of the key.",
    notes: [
      "Without --to, the command lists your other devices and you pick one. With --no-input, --to is required.",
      "Get the receiving device's id from that list, from dotrelay status, or from the server. It must be an active device on the same account.",
      "The key goes only to a device in your signed device roster. For a device that isn't in the roster yet, the command shows the key fingerprint the server reports. Compare it with dotrelay device list on that device. Confirming adds the device to the roster. With --no-input, a device outside the roster is refused.",
      "You can retry the transfer until the receiving device acknowledges it or it expires. If a response gets lost, the transfer can be accepted again. Once it's acknowledged or expired, create a new one.",
      "The command prints the transfer code: the transfer id, a dot, and your account fingerprint. On the receiving device, paste it into Recovery, or pass it to dotrelay device recover --transfer. That device checks the fingerprint.",
    ],
    options: {
      to: "id of the receiving device (required with --no-input)",
      profile: "server profile to transfer from (required with --no-input)",
      noInput: "never prompt. Needs --profile",
    },
    examples: [
      "dotrelay device transfer",
      "dotrelay device transfer --to <peer-device-id>",
    ],
  },
  "device revoke-wrapper": {
    about:
      "Retire an active recovery code wrapper, so the recovery code it protects can no longer unlock your account. Your account must keep at least one recovery code wrapper, and at least one active wrapper of any kind.",
    notes: [
      "Without --wrapper-id, the command lists your active wrappers and you pick one. With --no-input, --wrapper-id is required.",
      "The full wrapper id is printed when the wrapper is created, and in this command's result. Copy it from either place into --wrapper-id.",
    ],
    options: {
      wrapperId:
        "full id of the wrapper to revoke. Leave it out to pick from a list. Required with --no-input",
      profile: "server profile to revoke on (required with --no-input)",
      noInput: "never prompt. Needs --profile",
    },
    examples: [
      "dotrelay device revoke-wrapper",
      "dotrelay device revoke-wrapper --wrapper-id <wrapper-id>",
    ],
  },
  "device list": {
    about:
      "List your account's active devices on this server and mark this one. Other people's devices are never listed.",
    examples: ["dotrelay device list", "dotrelay device list --json"],
  },
  "project link": {
    about:
      "Link a project yourself. The CLI sends the GitHub repository's id to the server you're signed in to, which creates a default environment if the project is new.",
    options: {
      team: "id of the team to link the project to (required)",
    },
    notes: [
      "You need a signed-in session on an active, enrolled device. Signing in with dotrelay login isn't enough until this machine is enrolled as a device.",
    ],
    examples: ["dotrelay project link --team <team-id>"],
  },
  "project rotate": {
    about:
      "Move the linked project to a new epoch and seal a new project key for your account's devices. Use this when a device has been granted the current epoch but never received its key.",
    options: {
      profile: "server profile to rotate on (required with --no-input)",
      noInput: "never prompt. Needs --force",
      force: "confirm the rotation with --no-input",
    },
    notes: [
      "Rotation covers the whole project. It moves every active environment forward, so each one must already have a revision. Run it from a worktree whose selected environment is active.",
      "A device that couldn't read the previous epoch gets the new key. Run dotrelay pull on that device afterwards.",
    ],
    examples: [
      "dotrelay project rotate",
      "dotrelay project rotate --profile work --no-input --force",
    ],
  },
  "team list": {
    about:
      "List the teams you belong to and their ids, to use with --team. Two more lists follow: teams you joined that are still waiting for an owner or admin to share the project keys, and invitations you haven't accepted yet.",
    examples: ["dotrelay team list", "dotrelay team list --json"],
  },
  "team share-keys": {
    about:
      "Share the team's project keys with a member, so their devices can read every project in the team. This activates a member who accepted an invitation, and shares the keys again with a member who added a device. It does the same as Share project keys in the Members view of the web app.",
    positional: [
      "<github-login-or-user-id>  The member's GitHub login, or their user id from dotrelay team members.",
    ],
    options: {
      team: "team id (default: your only team, or the linked project's team)",
      fingerprint:
        "the member's account fingerprint, which you compared with them outside DotRelay. Required with --no-input until their identity is confirmed",
      noInput:
        "never prompt. Needs --force, plus --fingerprint for a member you haven't confirmed",
      force: "confirm sharing with --no-input",
    },
    notes: [
      "Only a team owner or admin can share keys. An admin can share only with members who have the member role.",
      "This device must be able to read every project in the team. Keys go only to devices in the member's signed device roster.",
      "Sharing confirms the member's account identity on this machine. Without a terminal, that needs --fingerprint with the value the member sees in their own dotrelay team members --fingerprints. --force alone never confirms an identity.",
    ],
    examples: [
      "dotrelay team share-keys octocat",
      "dotrelay team share-keys <user-id> --team <team-id>",
      "dotrelay team share-keys octocat --no-input --force --fingerprint 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    ],
  },
  "team decline": {
    about:
      "Decline a team invitation sent to you. To accept one, use the DotRelay web app.",
    positional: [
      "<invitation-id-or-team>  The invitation id from dotrelay team list, or the inviting team's id or name.",
    ],
    options: {
      noInput: "never prompt. Needs --force",
      force: "confirm declining with --no-input",
    },
    notes: [
      "You can't accept an invitation after you decline it. A team owner or admin has to invite you again.",
    ],
    examples: [
      "dotrelay team decline Platform",
      "dotrelay team decline <invitation-id> --profile work --no-input --force",
    ],
  },
  "team leave": {
    about:
      "Leave a team, ending your membership. As with a removal, every project in the team then needs a key rotation.",
    positional: [
      "<team-id-or-name>  The team's id or name from dotrelay team list.",
    ],
    options: {
      noInput: "never prompt. Needs --force",
      force: "confirm leaving with --no-input",
    },
    notes: [
      "The team's last active owner can't leave while other members remain. Make another active member an owner in the web app, or delete the team there.",
      "Values this machine already downloaded stay on it. The team's owners should run dotrelay project rotate.",
    ],
    examples: [
      "dotrelay team leave Platform",
      "dotrelay team leave <team-id> --no-input --force",
    ],
  },
  "account export": {
    about:
      "Export what this server holds about your account as JSON: your profile, teams and roles, devices, invitations, sessions, and activity times.",
    options: {
      output: "write the JSON to this file (mode 0600) instead of stdout",
    },
    notes: [
      "The export has no values, ciphertext, or keys. Decrypted values come only from a device, with dotrelay pull or dotrelay export.",
    ],
    examples: [
      "dotrelay account export --output account.json",
      "dotrelay account export --profile work",
    ],
  },
  "account delete": {
    about:
      "Delete your account on this server. Your sign-in, sessions, device keys, and recovery methods are deleted. Other members keep the history you wrote, shown as coming from a deleted user.",
    options: {
      noInput: "never prompt. Needs --force",
      force: "confirm deletion with --no-input",
    },
    notes: [
      "You can't delete your account while you're the last active owner of a team that has other members. Teams where you're the only member are deleted with the account.",
      "Afterwards, the session and this device's keys are removed from this machine. The server profile, pins, worktree contexts, and pulled .env files stay, and the command lists them.",
      "Signing in again with the same GitHub account creates a new, empty account.",
    ],
    examples: [
      "dotrelay account delete",
      "dotrelay account delete --profile work --no-input --force",
    ],
  },
  "team members": {
    about:
      "List the linked team's members and the state of each one's account identity. verified means a roster signed by their pinned account key lists their devices. unverified means there's no signed roster yet. A key change or rollback blocks the member until you check it.",
    options: {
      team: "team id (default: the linked project's team)",
      fingerprints:
        "show each member's account fingerprint so you can compare it with them",
    },
    notes: [
      "A member's account fingerprint never changes. If it has changed, the server presented a different account key. Check it with the member before you run dotrelay team trust.",
    ],
    examples: ["dotrelay team members", "dotrelay team members --fingerprints"],
  },
  "team trust": {
    about:
      "Confirm a member's account identity, or one that changed, after you've compared the fingerprint with them outside DotRelay. Until you do, this machine takes no keys from them and reads none of their legacy-format values. For a changed identity, it also doesn't accept their devices.",
    positional: ["<user-id>  The member's user id from dotrelay team members."],
    options: {
      team: "team id (default: the linked project's team)",
      fingerprint:
        "the fingerprint you compared with the member. It must match the identity the server presents",
      noInput: "never prompt. Needs --fingerprint",
      force:
        "accepted so older scripts keep working. It never confirms an identity",
    },
    notes: [
      "With --fingerprint, the command confirms only if the fingerprint matches. Without a terminal, that's the only way to confirm.",
    ],
    examples: [
      "dotrelay team trust <user-id>",
      "dotrelay team trust <user-id> --no-input --fingerprint 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    ],
  },
  "env list": {
    about:
      "List the environments in this worktree's project with their labels, ids, and state, and mark the selected one.",
    notes: [
      "Link a project first with dotrelay project link or dotrelay init.",
    ],
    examples: ["dotrelay env list", "dotrelay env list --json"],
  },
  "env create": {
    about:
      "Create an environment with this label in the worktree's project. You need to be a team owner or admin. Your selection doesn't change. To select the new one, run dotrelay env use <label>.",
    positional: [
      "<label>  The new environment's label. It starts with a letter, followed by up to 62 letters, digits, dots, dashes, or underscores.",
    ],
    notes: [
      "If an active environment already has that label, you get that environment back and nothing new is created.",
    ],
    examples: ["dotrelay env create staging", "dotrelay env create production"],
  },
  "env use": {
    about:
      "Select this worktree's environment by id or label, from the worktree's project. The choice is saved in the worktree context.",
    positional: [
      "<environment-id-or-label>  The environment to select. You can pass --environment instead.",
    ],
    options: {
      environment: "environment id or label (instead of the positional)",
    },
    notes: [
      "Link a project first with dotrelay project link or dotrelay init.",
    ],
    examples: [
      "dotrelay env use development",
      "dotrelay env use --environment <environment-id>",
    ],
  },
};

const GROUP_ABOUT: Readonly<Partial<Record<CommandName, string>>> = {
  profile: "Save, choose, and list the server profiles this machine trusts.",
  device:
    "Enroll this machine, approve new devices, and recover or send your account key.",
  project: "Link this GitHub repository's project, or rotate its keys.",
  team: "See your teams and their members, share project keys, decline invitations, or leave a team.",
  account: "Export or delete your account on a server.",
  env: "List, create, and select the environments in this worktree's project.",
};

const SHARED_FLAG_SUMMARIES: Readonly<Partial<Record<FlagKey, string>>> = {
  profile: "server profile to use (default: the selected profile)",
  environment: "environment id or label (default: this worktree's selection)",
  output: "file to write",
  from: "file to read",
  recoveryCodeFile: "path to a file that holds your recovery code",
  transfer: TRANSFER_CODE,
  to: "id of the device to send the account key to",
  wrapperId: "id of the account key wrapper to revoke",
  team: "team id, used to find the project",
  name: "not used by any command",
  remote: "Git remote to use when more than one could identify this worktree",
  limit: "how many revisions to fetch, from 1 to 256 (default: all)",
  classify:
    "set who owns a new variable: shared (Team) or user-defined (Only me)",
  variable: "variable to roll back, by name or id. Repeat for more",
  format: "output format: dotenv, json, or shell",
  allowEnv:
    "let through a named variable that controls how programs or shells start. Repeat for more",
  noOpen: "don't open the verification page in a browser",
  noInput: "never prompt, guess, or approve anything",
  force: "approve the destructive step this command describes",
  json: "JSON output for scripts. Values never appear in it",
  reveal:
    "show plaintext values in the one review you see, never in JSON or diagnostics",
  stdout: "write values to stdout. A terminal also needs --reveal",
};

const FLAG_SIGNATURES: Readonly<Partial<Record<FlagKey, string>>> = {
  profile: " <name>",
  environment: " <environment-id-or-label>",
  output: " <file>",
  from: " <file>",
  recoveryCodeFile: " <path>",
  transfer: " <transfer-code>",
  to: " <peer-device-id>",
  wrapperId: " <wrapper-id>",
  team: " <team-id>",
  remote: " <remote-name>",
  limit: " <count>",
  classify: " NAME=shared|user-defined",
  variable: " <variable-name-or-id>",
  format: " <dotenv|json|shell>",
  allowEnv: " <name>",
};

// Mirrors the parser's token walk well enough to route --help: the first
// non-flag token is the command, and a grouped command (profile, device,
// project, env) takes one more non-flag token as its subcommand.
export const helpTopicFor = (args: readonly string[]): string[] => {
  const topic: string[] = [];
  for (const token of args) {
    if (token === "--") break;
    if (token.startsWith("-")) continue;
    topic.push(token);
    if (topic.length === 2) break;
    const first = topic[0];
    if (!first || !SUBCOMMANDS[first as CommandName]) break;
  }
  return topic;
};

export const helpLabelFor = (topic: readonly string[]): string | null => {
  if (topic.length === 0) return null;
  const command = topic[0];
  if (!command || !COMMANDS.includes(command as CommandName)) return null;
  const subcommands = SUBCOMMANDS[command as CommandName];
  if (subcommands) {
    if (topic.length === 1) return command;
    const sub = topic[1];
    if (topic.length !== 2 || !sub) return null;
    return subcommands.includes(sub) ? `${command} ${sub}` : null;
  }
  return topic.length === 1 ? command : null;
};

const wrapLines = (text: string, width: number, indent: string): string[] => {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(`${indent}${current}`);
      current = word;
    }
  }
  if (current.length > 0) lines.push(`${indent}${current}`);
  return lines;
};

const wrapped = (text: string, width: number, indent: string): string =>
  wrapLines(text, width, indent).join("\n");

const renderLeafHelp = (label: string): string => {
  const entry = COMMAND_HELP[label];
  if (!entry)
    throw new CliInvocationError(
      `There's no help for ${label}. Usage: dotrelay help [<command>]`,
    );
  const lines = [
    `${bold("Usage:")} ${usageForLabel(label)}`,
    "",
    ...wrapLines(entry.about, 64, "  ").map((line) => paint(line, "muted")),
  ];
  if (entry.positional?.length) {
    lines.push("", paint("Arguments:", "info"));
    for (const line of entry.positional)
      lines.push(wrapped(`  ${line}`, 72, "  "));
  }
  lines.push("", paint("Options:", "info"));
  const allowed = FLAG_PERMISSIONS[label] ?? [];
  const signatures = FLAG_KEYS.filter((key) => allowed.includes(key)).map(
    (key) => {
      const summary = entry.options?.[key] ?? SHARED_FLAG_SUMMARIES[key] ?? "";
      return `  ${FLAG_TOKENS[key]}${FLAG_SIGNATURES[key] ?? ""}  ${summary}`;
    },
  );
  signatures.push("  --debug  include sanitized details in error output");
  const parsed = signatures.map((line) => {
    const body = line.slice(2);
    const index = body.indexOf("  ");
    return {
      flag: index === -1 ? body : body.slice(0, index),
      summary: index === -1 ? "" : body.slice(index + 2),
    };
  });
  const flagWidth = Math.max(...parsed.map((row) => row.flag.length), 4);
  for (const { flag, summary } of parsed) {
    lines.push(
      `  ${bold(flag.padEnd(flagWidth))}${
        summary.length > 0 ? `  ${paint(summary, "muted")}` : ""
      }`,
    );
  }
  if (entry.notes?.length) {
    lines.push("", paint("Notes:", "info"));
    for (const note of entry.notes) lines.push(wrapped(`  ${note}`, 72, "  "));
  }
  lines.push("", paint("Examples:", "info"));
  for (const example of entry.examples)
    lines.push(`  ${paint(">", "ghost")} ${example}`);
  return lines.join("\n");
};

const renderGroupHelp = (command: CommandName): string => {
  const subcommands = SUBCOMMANDS[command] ?? [];
  const lines = [`${bold("Usage:")} dotrelay ${command} <subcommand>`, ""];
  const about = GROUP_ABOUT[command];
  if (about)
    lines.push(
      ...wrapLines(about, 64, "  ").map((line) => paint(line, "muted")),
      "",
    );
  lines.push(paint("Subcommands:", "info"));
  const subs = subcommands.map((sub) => ({
    sub,
    about: COMMAND_HELP[`${command} ${sub}`]?.about ?? "",
  }));
  const nameWidth = Math.max(...subs.map((row) => row.sub.length), 4);
  for (const { sub, about } of subs)
    lines.push(
      `  ${bold(sub.padEnd(nameWidth))}${
        about.length > 0 ? `  ${paint(about, "muted")}` : ""
      }`,
    );
  lines.push(
    "",
    paint(
      `Run dotrelay help ${command} <subcommand> for one subcommand's full help.`,
      "faint",
    ),
  );
  return lines.join("\n");
};

export const renderCommandHelp = (label: string): string => {
  const [command, sub] = label.split(" ");
  // `context` still runs with no subcommand. Only its repair verb is nested.
  if (
    command &&
    command !== "context" &&
    SUBCOMMANDS[command as CommandName] &&
    !sub
  )
    return renderGroupHelp(command as CommandName);
  return renderLeafHelp(label);
};

// The command directory. Usage prefixes are taken verbatim from the parser's
// usage table (the primary form, before any " | " alternative) so the
// directory can never drift from what the parser accepts.
const EVERYDAY_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["setup", "Connect to a server, sign in, and enroll this machine"],
  ["login", "Sign in and enroll this machine"],
  ["init", "Publish this repository's .env for the first time"],
  ["push", "Publish changes from .env"],
  ["pull", "Write the decrypted values to .env"],
  ["run", "Start a command with the values in its environment"],
  ["diff", "Compare .env with the environment"],
  ["status", "Show this machine's connection and repository"],
];

const POWER_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["help", "Show this list, or the help for one command"],
  ["list", "List the environment's variable names"],
  ["export", "Print decrypted values as dotenv, JSON, or shell"],
  ["profile add", "Save a server profile"],
  ["profile use", "Choose the default server profile"],
  ["profile list", "List your saved server profiles"],
  ["profile rebind", "Re-pin a server profile after its address changes"],
  ["logout", "Sign out and remove the local session"],
  ["device enroll", "Enroll this machine as a device"],
  ["device begin", "Ask another device of yours to approve this one"],
  ["device approve", "Approve an enrollment request"],
  ["device complete", "Finish an approved enrollment"],
  ["device backup", "Create a recovery code for your account"],
  ["device recover", "Unlock this device with a recovery code or transfer"],
  ["device setup", "Create your account key and its recovery code"],
  ["device transfer", "Send your account key to another device"],
  ["device revoke-wrapper", "Retire an active recovery code wrapper"],
  ["device list", "List your account's devices"],
  ["context", "Find this worktree's GitHub repository"],
  ["context reselect", "Clear an outdated project or environment selection"],
  ["project link", "Link a project yourself"],
  ["project rotate", "Rotate the project's keys"],
  ["team list", "List your teams and their ids"],
  ["team members", "List members and their account fingerprints"],
  ["team trust", "Confirm a member's identity, or one that changed"],
  ["team share-keys", "Share the project keys with a member"],
  ["team decline", "Decline a team invitation"],
  ["team leave", "Leave a team"],
  ["account export", "Export your account data as JSON"],
  ["account delete", "Delete your account on this server"],
  ["env list", "List the project's environments"],
  ["env use", "Select an environment by id or label"],
  ["env create", "Create an environment with a label"],
  ["history", "List verified revisions and what changed"],
  ["rollback", "Roll variables back to an earlier revision"],
  ["update", "Install the newest version of dotrelay"],
];

// Aligned flag rows for the directory views; the width follows the longest
// flag so a long signature can never push its summary out of line.
const flagRows = (rows: ReadonlyArray<readonly [string, string]>): string[] => {
  const width = Math.max(...rows.map(([flag]) => flag.length));
  return rows.map(
    ([flag, summary]) =>
      `  ${bold(flag.padEnd(width))}  ${paint(summary, "muted")}`,
  );
};

const commandDirectory = (
  items: ReadonlyArray<readonly [string, string]>,
): string[] => {
  const usages = items.map(([label]) => {
    const usage = usageForLabel(label)
      .replace(/^dotrelay /, "")
      .split(" | ")[0];
    return usage ?? "";
  });
  const width = Math.max(...usages.map((usage) => usage.length), 4);
  return items.map(
    ([, summary], index) =>
      `  ${bold((usages[index] ?? "").padEnd(width))}  ${paint(summary, "muted")}`,
  );
};

export const renderHelp = (): string => {
  const lines = [
    banner(),
    "",
    `${bold("Usage:")} dotrelay <command>`,
    "",
    section("Everyday"),
    ...commandDirectory(EVERYDAY_COMMANDS),
    "",
    section("More"),
    ...flagRows([
      ["dotrelay help", "Every command, with flags and examples"],
      ["dotrelay help <command>", "Full help for one command"],
    ]),
    "",
    section("Flags"),
    ...flagRows([
      ["--profile <name>", "Choose the server profile"],
      ["--environment <label>", "Choose the environment by label or id"],
      ["--json", "JSON output for scripts. Values never appear"],
      ["--no-input", "Never prompt, guess, or approve anything"],
      ["--debug", "Include sanitized details in error output"],
      ["-h, --help", "Show help. -v or --version shows the version"],
    ]),
  ];
  lines.push(
    "",
    paint(
      defaultOrigin
        ? `With no server profile selected, this build uses ${defaultOrigin}.`
        : `New here? Run dotrelay setup ${HOSTED_ORIGIN} for the hosted service, or use your own server's address if you self-host.`,
      "faint",
    ),
  );
  return lines.join("\n");
};

export const renderPowerHelp = (): string => {
  return [
    banner(),
    "",
    `${bold("Usage:")} dotrelay <command> [subcommand]`,
    "",
    section("Everyday"),
    ...commandDirectory(EVERYDAY_COMMANDS),
    "",
    section("Power"),
    ...commandDirectory(POWER_COMMANDS),
    "",
    paint(
      "Run dotrelay help <command> or dotrelay <command> --help to see one command's arguments, options, and examples.",
      "faint",
    ),
    "",
    section("Shared flags"),
    ...flagRows([
      ["--profile <name>", "Server profile to use"],
      ["--environment <label>", "Environment label or id"],
      ["--team <id>", "Team to look the project up in (see team list)"],
      ["--json  --no-input", "For scripts. No prompts and no guesses"],
      ["--force", "Approve the destructive step the command describes"],
    ]),
    "",
    section("Notes"),
    "  pull writes decrypted values. It refuses a file Git tracks, and adds",
    "  an untracked one to .git/info/exclude. Change previews show names and",
    "  change types only. --reveal shows plaintext values for one review,",
    "  never in JSON or diagnostics.",
    "",
    "  rollback adds a signed rollback revision for the variables you pick.",
    "  Earlier revisions are never rewritten or removed.",
    "",
    "  Values never appear in diagnostics. There's no --insecure flag, and",
    "  credentials can't be passed as flags.",
  ].join("\n");
};
