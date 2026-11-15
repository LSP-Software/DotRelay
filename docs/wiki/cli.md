# Standalone CLI

The `dotrelay` binary exposes the command contract. The `@dotrelay/cli` npm package installs it and selects the native
binary staged for the current platform and forwards the same arguments to it.

Everyday commands are `setup`, `login`, `init`, `push`, `pull`, `run`, `diff`, and `status`. Power
commands stay available and are listed by `dotrelay help`. `-h` and `-v` are short for `--help` and
`--version`, and `-o <path>` is short for `--output <path>`. `dotrelay help <command>` — or `dotrelay <command> --help`,
including nested commands such as `dotrelay device recover --help` — renders the usage line, required
arguments, options, defaults, noninteractive requirements, and safe examples for that one command. The
help is generated from the same command registry the parser uses, so it cannot drift from the accepted
syntax, and validation errors carry the relevant usage line.

## Install

The install scripts download a release archive from GitHub, check it against the release's
`SHA256SUMS`, and abort on a mismatch. They need no root or administrator rights and send nothing
but the downloads.

```sh
# Linux (glibc) and macOS; needs curl, tar, and sha256sum or shasum
curl -fsSL https://raw.githubusercontent.com/LSP-Software/DotRelay/main/scripts/install.sh | sh
```

```powershell
# Windows x64, PowerShell 5.1 or 7
irm https://raw.githubusercontent.com/LSP-Software/DotRelay/main/scripts/install.ps1 | iex
```

| Variable               | Default                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `DOTRELAY_VERSION`     | the latest stable release; set `1.2.3` or `v1.2.3-alpha.1` to pin one |
| `DOTRELAY_INSTALL_DIR` | `~/.local/bin` (Unix), `%LOCALAPPDATA%\DotRelay\bin` (Windows)        |

With no stable release yet, the scripts install the newest prerelease (alphas are versions of the
hosted service). When the install
directory is not on `PATH`, the script prints the line to add. Re-running a script replaces the
installed binary. The scripts are served from `main`, not from a release, so a fix to them applies
to every version they install.

`npm install -g @dotrelay/cli` installs the same binary. The selector package is small; npm also
installs the one `@dotrelay/cli-<platform>-<arch>` package that matches the machine. Release
targets are `linux-x64`, `linux-arm64` (glibc), `darwin-x64`, `darwin-arm64`, and `win32-x64`.

Each GitHub release carries `dotrelay-<tag>-<platform>-<arch>.tar.gz` (`.zip` on Windows),
`SHA256SUMS`, and a signed build provenance attestation. To check a manual download against the
attestation as well, run
`gh attestation verify dotrelay-<tag>-<platform>-<arch>.tar.gz --repo LSP-Software/DotRelay`.

## Version and launch diagnostics

`dotrelay --version` reports the release version the release build stamped into the compiled
binary, so it agrees with the tagged/npm release the operator installed; source builds report
the `0.0.0-foundation` identifier, and the npm selector reports the same version as the binary
it launches. The selector finds the binary in the `@dotrelay/cli-<platform>-<arch>` package that
npm installed beside it as an optional dependency. When it cannot launch the binary — the
platform package is missing (installed with `--omit=optional`, or from a lockfile made on another
platform), the platform is unsupported (including musl Linux), the package is from another
version, or the binary is not executable or not launchable here — it exits with code 1 and
reports the release it is running, the `<platform>-<arch>` the machine needs, the platforms the
release publishes, and the repair: `npm install -g @dotrelay/cli@<version>`, the install script,
or a binary from the DotRelay GitHub releases (see [Install](#install)). A `DOTRELAY_BINARY`
override that points at a missing or unlaunchable binary is named in the same report; the
override must be an absolute path. The selector never launches a binary from elsewhere in the
surrounding project. It forwards `SIGINT`, `SIGTERM`, and `SIGHUP` to the binary and re-raises
the signal that ended it.

## Release channels

The npm selector is published in two flavors. The `dev` flavor is rebuilt from the most recent
commit on `main` on every push: its binary targets the dev API, and when no Server Profile is
selected it trusts and selects `https://dev-api.dotrelay.dev` on first use — a fresh machine runs
`npm install -g @dotrelay/cli@dev` and then `dotrelay login` without a `setup` step. Its version
records the commit it was built from (`@dotrelay/cli@0.0.0-dev.<commit-sha>`), and
`dotrelay --version` reporting a `0.0.0-dev` identifier names a dev build. Release tags publish
the `latest` flavor instead: that binary targets no origin, so a new machine still begins with
`dotrelay setup <origin>` (for the hosted service, `https://api.dotrelay.dev`). A dev build that
also needs the hosted service adds it with `dotrelay profile add` and `dotrelay profile use`.

## First machine and sign-in

The first invocation has no ambient Server Profile. `dotrelay setup <origin>` fetches and verifies
`/api/v1/capabilities`, saves that pin, selects it, signs in with Better Auth device authorization,
and enrolls the first Device on this machine. Adding a profile selects it when none is selected.
A command-level `--profile <name>` override wins over the global selection. The catalog stores only
the exact origin and immutable server profile id; a changed identity or origin requires an explicit
trust decision.

Interactive setup and `profile add` confirm trust with Enter. `--no-input` never guesses and still
requires `--accept-profile <server-profile-id>`.

`dotrelay login` reuses an existing profile: it waits on the user code, then bootstraps the
first Device if this machine does not already have one. Bootstrap is first-Device-only, so a
machine joining an account that already has a Device gets a conflict from the bootstrap and
should run `dotrelay device enroll` instead. Login does not receive a GitHub token.
Before it starts waiting it shows the copyable verification URL, the user code, and the
code expiry. The shown URL is validated against the pinned Server Profile
and is the one to open: when the service supplies a complete URL it already includes the user
code. `--no-open` suppresses opening the browser, and `--no-input` never attempts to open one (for
example over SSH); in both cases the same URL, code, and expiry are shown so the User can open the
URL manually. When the browser launcher is unavailable, fails to start, or exits nonzero, the CLI
shows that manual path instead of aborting and keeps polling for the authorization to complete.
If the server admits only listed GitHub accounts (the private alpha) and the browser is signed in
with one that isn't listed, login and setup stop with a "Private alpha" error (exit 6,
`alpha_admission_required`). Against the hosted origin it says to email support@dotrelay.dev;
against any other server, to ask its operator. A command run with an older session that is no
longer admitted gets the same error. `dotrelay logout`, then `dotrelay login`, switches accounts.
Session material and Device wrapping keys belong in the local credential store — encrypted files
in the CLI state directory (`DOTRELAY_CONFIG_DIR`) — scoped by Server Profile. The encrypted
Device bundle itself is a protected local record. The store's key sits beside the data it wraps,
so the state directory is only as private as its modes: every command except `help` restricts the
directory and its `credentials` directory to `0700` and the files the CLI keeps there to `0600`,
repairing older or copied state, never follows a symlink while doing so, and stops if an entry
belongs to another user. Without `DOTRELAY_CONFIG_DIR`, the state directory comes from an absolute
`XDG_CONFIG_HOME` or `HOME` (`APPDATA` on Windows); when none is set the command stops rather than
keeping keys in the working directory. A new Recovery Code waits in the credential store, not in
a plaintext file, until a run has shown it.

`logout` signs out: it revokes the session on the Server Profile (Better Auth sign-out with the
stored bearer session) and deletes the local copy. When the server cannot be reached, the local copy
is still deleted and the result says the server-side session was not revoked; it expires on its own.
`--insecure`, certificate bypasses, and token/device-key flags are rejected.

## Repository and worktree context

`context` normalizes GitHub SSH and HTTPS remotes, then resolves the descriptive
`owner/repo` name to GitHub's stable numeric Repository Identity. The CLI never calls the
GitHub API itself and never sends a GitHub token: it asks the Server Profile to resolve the
name on the signed-in User's behalf, using the fine-grained GitHub App grant the User made
while signing in (Delegated GitHub Access). Protected commands use that identity to
automatically find the accessible Project, so a saved Project selection is not required when
running from its repository. Missing repository remotes, or an unlinked repository, fail
closed. When several remotes name different GitHub Repositories — the normal fork checkout,
with `origin` on the fork and `upstream` on the source — the CLI lists the remote names with
their repository names, never the remote URLs or credentials, and asks which
remote identifies this worktree. `--remote <remote-name>` is the documented noninteractive
override for the commands that resolve a repository; under `--no-input`, an ambiguous worktree
fails naming the exact `--remote` choices instead of guessing. The choice is recorded in the
worktree context together with the verified Repository Identity, and while the remote still
points at that Repository the recorded identity is trusted as-is: an established linkage
never asks the Server Profile to reach GitHub again. When the remote is removed or repointed,
the recorded choice is discarded and the choice is made again from the current remotes: the CLI
asks again when more than one Repository remains, and under `--no-input` fails naming the
exact `--remote` choices; a stale choice is never followed to a different Repository. A remote
that now names a different Repository than the one recorded for this worktree is a conflict,
not a relink: re-point the remote, or re-record the choice with `dotrelay context --remote
<remote-name>`. When GitHub renames or transfers a Repository, the same identity resolves to
its current `owner/repo` name and the recorded choice follows it. If the User's Delegated
GitHub Access cannot see the Repository, resolution fails with `repository_access_denied`.
GitHub shows DotRelay only the repositories its GitHub App is installed on, and signing in
installs nothing: install the App on the Repository's owner and choose the Repository. The CLI
asks the Server Profile for the install link (`GET /api/v1/github-app`) and prints it; a server
without `GITHUB_APP_SLUG` gets a hint to ask its operator. Also check that the account can
access the Repository — the endpoint is not an existence oracle, so denial and absence answer
identically. GitHub rate
limits surface as `github_rate_limited` with the retry window to wait, and an unreachable
GitHub as `github_unavailable`; established sync through the Server Profile is unaffected by
either. When no session or active Device is available, `context` reports the descriptive
selection and the recorded identity instead, with the sign-in or enrollment step to take.
Choosing a remote only selects which Repository identity to resolve: like detection, it never
grants Membership or secret access, and the Server Profile still scopes every request to the
Projects the User's Teams can reach.

Environment selection is by opaque id or operator-visible label, and is worktree local.
`.git/dotrelay/config` may contain only the Server Profile, Project, Environment, chosen
repository remote, and verified repository identity opaque ids, never Values or remote URLs. When neither the command arguments nor the saved selection name an Environment,
the CLI chooses automatically only when exactly one active Environment is available; otherwise
it lists the Environment labels and asks. Archived Environments are never selected automatically
and can only be addressed with an explicit `--environment`. The saved selection is written only
after the command succeeds, so a failed or declined run leaves it untouched. `--no-input`
requires the profile to be supplied explicitly and never guesses a Team or Environment: for
`pull`, `diff`, `history`, and `rollback` the Environment must be explicit or already saved in
the worktree, while `init` and `push` may additionally use the Project's single active
Environment.

`dotrelay context reselect` clears a stale Project or Environment selection. It copies the
worktree context into the state directory before replacing it, and it never deletes Device
keys or trusted Revision history. `--no-input` requires `--force`.

`dotrelay profile rebind <name> <origin>` re-pins a saved profile after its origin or server
identity moves. The approval names the previous and next origin and server profile id, keeps
Device keys, and resets trusted Revision continuity (saved heads and publication baselines) only
for Environments whose saved head was verified against that profile's previous server profile id.
Saved heads of other profiles, and older saved heads that do not record a server profile id, are
kept. `--no-input` requires `--force`.

`env list` shows the worktree Project's Environments with their labels, ids, and state, and marks
the selected one. `env create <label>` creates an Environment (Team owners and admins only); a label
starts with a letter and has up to 63 letters, digits, dots, dashes, or underscores. It does not
change the selection: follow it with `env use <label>`, or publish into it with
`push --environment <label>`. A label that matches no Environment fails with the labels that do
exist and the `env create` command to run. `init <label>` on a Project that the same run creates
sends the label with the Project (`environmentLabel` on `POST /api/v1/projects`), so the first
Environment gets it instead of `default`.

`project link --team <team-id>` sends the resolved numeric Repository id to the authenticated
Server Profile. The Server Profile resolves the owner and name again with the User's Delegated
GitHub Access and links the Project only when GitHub reports the same Repository id
(`repository_access_denied` otherwise). It creates a default Environment in the same transaction
when the Project is new, and returns the existing Project and Environment on retry. It requires an
authenticated session and an active enrolled Device; a session from `login` alone is insufficient
until this machine has a Device.

Every command that acts as this machine's Device proves it holds the Device key
([ADR 0020](../adr/0020-device-proof-of-possession.md)): the first such request of a run signs a
service challenge with the Device's Ed25519 key and sends the resulting Device proof with every
later request. A Device the service no longer considers active cannot get a proof, so `status`
reports it as not active and other commands fail with `device_not_active`. `env use <environment-id-or-label>` resolves the reference within
the worktree's Project and reads opaque Environment metadata and the operator-visible label.

## Encrypted workflows

`init` and `push` use `.env` by default. When the GitHub Repository is not yet linked, both commands
create the missing Team, Project, and Environment: the only Team is used automatically, multiple
Teams are chosen from a terminal list, and zero Teams prompts to create one (defaulting the name to
the repository owner). Use `--team <team-id>`, an Environment id or label, or `--from <dotenv>` only
to override those defaults. If the Environment already has a genesis Revision, `init` continues as
`push` instead of failing.

New Variables must be classified as shared or user-defined. Interactive `init` shows a board of
every Variable name (never Values) and lets you toggle Team vs Only you before continuing. `push`
shows that board only for names that are not already in the Environment; existing Variables keep
their ownership. JSON and `--classify` still use `shared` and `user-defined`. `--classify NAME=shared`
or `--classify NAME=user-defined` skips the board when every new Variable is covered, and is required
under `--no-input` for unclassified names. Existing Variable ids are retained, and empty Values
remain Values rather than being dropped. A push is reconciled against the Publication Baseline
recorded for that file. `pull` records the head it wrote, including a pull that finds no
changes. A file with no baseline uses the head at the start of that push. A teammate's addition
or edit to a Variable this file did not change is kept. The same Variable changed on both sides
pauses the publication until the operator chooses keep local, keep remote, or, when the
definition also differs, merge. Under `--no-input` that conflict fails, names the Variables,
and leaves the file and the baseline untouched. A successful publication does not move the
baseline. A Variable that is in the baseline and absent from the file becomes a signed
tombstone.

A line that still matches the baseline never undoes a teammate's change. If the Environment
deleted a Variable since the baseline, an unchanged line lets the deletion stand, and an edited
line pauses as a conflict. The same holds when a teammate deleted the Variable and then added a
new one under the same name. A file with no recorded baseline (a new machine, cleared state, or a
path spelled differently) prints a notice that each differing Value in it will replace the
remote one, and suggests `dotrelay pull` first. Under `--no-input` that push is refused when it
would replace or remove an existing Value, until the file is pulled or `--force` is passed;
additions alone go through. After one publication from such a file succeeds, later pushes treat
it as reconciled. Baselines are keyed by the file's real path, so a symlinked path and its
target share one. `init` and `push` warn when the input file is tracked by Git, and a missing
input file is named along with `--from <file>`.

Interactive `init` and `push` confirm only Variables that will change. The default review is
masked: each change lists the Variable name, its ownership (shared or user-defined), and the
change type, and no plaintext Value is printed. Passing `--reveal` makes that one confirmation
show the full unified Value diff instead: the Variable name comes first, then a `-` line for the
current Value and a `+` line for the next Value. Added Variables omit the `-` line. Removed
Variables omit the `+` line. The shared prefix and suffix stay on both lines, and only the edited
span is marked. Reveal is scoped to that single review: the next review is masked again, and
JSON, progress, and diagnostics never contain Values regardless of `--reveal`. Unchanged
Variables are omitted. The review names the destination Server Profile, Team, Project, and
Environment before asking, so a publication is never directed at an Environment the operator did
not choose.
On an interactive terminal the question is answered with a Yes/No selector: the highlighted
choice (No by default) is confirmed with Enter, ↑↓ or j/k moves the highlight, Esc declines, and
`y`/`n` answer directly. When stdin is not a terminal the typed `y/N` line answer is used
instead, so scripts and `--no-input` behave exactly as before.
`--no-input` skips the prompt but never approves a destructive publication: when the change
removes Variables, `--no-input` alone is refused and the operator must additionally pass
`--force` to publish the removals. Publications that only add or update Variables proceed under
`--no-input` without it.

Publication progress is Encrypting values, Uploading, then Uploaded, followed by a Published
summary. The CLI reviews the publication
summary before beginning staging. It then uploads the signed command and encrypted protocol
objects, finalizes the operation with the expected head and epoch, and cancels a failed operation
when the Server Profile permits cancellation.

Every Revision carries a signed authored-at time. The CLI never stamps one earlier than this
Device's activation, your current Membership's activation, or the head Revision it builds on; a
slow local clock is raised to that floor. `project rotate` builds on every active Environment's
head, so it raises the floor to the latest head in the Project, using the head times that
`GET /api/v1/projects/:projectId/environments` lists. The Server Profile also refuses a time more than 10
minutes ahead of its own clock. Either refusal fails with `authored_at_out_of_range` (exit 4):
check the machine's system clock and time zone, then run the command again.

A Member who was removed and invited back keeps their earlier Revisions verifiable. The Server
Profile lists every Membership period for each signing Device, and the CLI checks each Revision
against the period it was authored in. A Revision authored between two periods is still refused.

`project rotate` advances the Project to a new epoch across every active Environment. It needs
the current Project Epoch Key: it seals that key under the new one in a Project Epoch Key Link
and sends the link with the rotation, so a Device that cannot read the current epoch is refused
before anything is sent. Rotation keeps a removed Member from reading Values published afterwards;
it does not revoke Values they already saw, so rotate a leaked secret itself as well. Every `pull`
rebuilds earlier epoch keys from the Project's key chain, and publishes any link missing from a
Project rotated before links existed when the Account Master Key holds both keys.

After a Member is removed or a Device revoked, the Server Profile records that the Project owes a
rotation until one commits. Every protected command in that Project then prints a pending action,
for example `1 Member removed since 2026-11-01. A Team owner or admin should rotate this Project's
key with dotrelay project rotate, then change the secrets they could read.` JSON results carry it
in `pendingActions`, and `status --json` reports `rotationOwed` with the counts. It is advice
only: nothing is blocked while the rotation is owed.

`team members` lists the linked Team's Members with the state of their account identity:
verified, not confirmed, unverified (no signed Device roster yet, so none of their Devices are
trusted), or blocked because the account key changed or the roster rolled back. `--fingerprints`
adds each Member's account fingerprint for comparison out of band. The first time this
installation sees a Member, it pins their identity: their Revisions verify, but no Project key is
taken from them until you confirm the fingerprint. `team trust <user-id>` confirms a Member seen
for the first time, or re-trusts one whose identity changed, after you compare fingerprints;
`--no-input` requires `--force`. Until a changed identity is re-trusted, the CLI does not accept
that Member's Devices. Every protected command also verifies this account's own roster and
publishes a new one when this Device holds the AMK and is not listed yet; a first roster lists only
this Device. Each installation also pins the highest epoch and the key it accepted for each
Project, and refuses an older epoch or a different key for the same epoch.

`team list` lists the Teams you belong to with the ids `--team` takes. It also lists Teams you
joined that are still waiting for their Project keys, and invitations you have not accepted yet,
each with its invitation id. Accept an invitation in the web app. `team decline
<invitation-id-or-team>` declines one, named by its invitation id or the inviting Team's id or
name, after a confirmation; `--no-input` requires `--force`. A declined invitation cannot be
accepted later: an owner or admin has to invite you again. The CLI cannot send or revoke
invitations; owners and admins do that in the web app.

`team leave <team-id-or-name>` ends your own Membership after a confirmation; `--no-input`
requires `--force`. It needs only a session. Like a removal, every Project of the Team then owes a
key rotation. The Team's last active owner gets `owner_transfer_required` while other Members
remain: promote another active Member to owner, or delete the Team, in the web app. Deleting a
Team is web-only.

`account export` prints the account data the Server Profile holds about you as JSON (profile,
Teams and roles, Devices, invitations, sessions, activity timestamps); `--output <file>` writes it
with mode 0600 instead. It holds no Values, ciphertext, or keys: `pull` or `export` on a Device
is how to keep a copy of Values. `account delete` deletes the account
([what deletion keeps](account-deletion.md)). It first lists the Teams it would leave or delete
and refuses while you are a Team's last active owner, then asks you to type `delete my account`;
`--no-input` requires `--force`. Afterwards it removes this profile's session and this Device's
keys from the machine and lists what stays: the Server Profile entry, trusted-head and teammate
pins, worktree contexts, and any `.env` files you pulled.

A new Member cannot read anything until a Team owner or admin shares the Project keys with them.
`pull` only shares keys among the puller's own Devices (any active Member's pull does this), so a
teammate's pull never helps. The owner
or admin chooses **Share project keys** for the Member in the web app's Members view, or runs
`dotrelay team share-keys <github-login-or-user-id>` from a Device that can read every Project in
the Team. A login is matched case-insensitively against the login each Member last signed in
with, as the membership list reports it; when none or several match, the service resolves the
login to a GitHub user id instead. The match only picks the Member: keys go to that Member's User
id and signed roster. The command reads the service's provisioning plan for that Membership, opens each
Project's current key, seals it only to Devices in the Member's signed Device roster, and posts
the signed activation; `--no-input` requires `--force`. The question names the Member's account
fingerprint, and sharing confirms it. A Member without a signed Device roster cannot receive keys
yet. The Member then runs `dotrelay pull`.
While a Membership is waiting for keys, protected commands in that Repository say so and name
this step, instead of reporting the Repository as unlinked or creating a second Team and Project
for it.

`device list` lists this account's active Devices and marks this one, with this Device's key
fingerprint computed from its own keys. Another Device compares it before sending this one the
account key.

`pull` writes decrypted Values to `.env` by default. Before any Value is decrypted or moved, `pull`
checks the output path's Git tracking state in the repository it resolves against (including linked
worktrees and custom `--output` paths). A Git-tracked output is refused with the two safe choices:
untrack it (`git rm --cached <path>`, which the operator runs — the CLI never changes Git history
or removes tracked content on the operator's behalf) or pull to a different `--output` path.
`--force` does not override this refusal. An untracked output is added to the repository-local
exclusion list (`.git/info/exclude`, which is never committed) so a later `git add` cannot pick the
plaintext file up, and the run reports that it established the exclusion; an already-ignored output
is left as-is and reported as such. The CLI runs Git with `core.fsmonitor`, hooks, the untracked
cache, the pager, and remote protocols turned off, so checking a repository it did not create
(such as an unpacked archive with its own `.git`) never runs a program that repository names.
Interactive `pull` confirms before replacing
an existing file, using the same masked review as `push` but from the current file to the
Environment, and names the same destination; `--reveal` shows the unified Value diff in that one
confirmation instead. Identical Values report that no changes were found and leave the file
untouched.
`--no-input` skips the prompt and never approves replacing a file on its own: when the existing
file differs from the Environment, `--no-input` alone retains the file and fails with an
actionable diagnostic (`output_conflict`) that points at `--force`. With `--force` under
`--no-input`, or with the interactive confirmation, the replacement is written and the prior file
is retained at `<path>.previous` so it stays recoverable. `pull --output <path>` and
`pull --stdout` first verify the complete v3 history from genesis. A Value this Device cannot
decrypt fails the export before anything is written and names the Variables. A required
Variable with no value is named too: interactive pull asks for it without echoing, and
`--no-input` says to add it to a dotenv file and push. Optional Variables with no value are
left out of the file, and the report counts them. Terminal stdout requires explicit `--reveal`
and confirmation; ordinary diagnostics never contain Values.

`pull` compares an existing file with the baseline it recorded. A local change that no verified
Revision since that baseline ever held has not been pushed. The interactive review lists those
changes separately as "will be lost", and under `--no-input --force` the pull is refused unless
`--discard-local` is also passed. A pull rewrites the whole file from the Environment, so
comments, blank lines, and the order of entries are not kept. Each replacement keeps up to three
earlier copies (`<path>.previous`, `<path>.previous.1`, `<path>.previous.2`), all mode `0600` and
excluded from Git. A copy identical to the new file or to the newest backup is not kept twice.
When the output is a symlink, the file it points at is replaced and the link stays. The Git
check runs on that file in its own repository, so a link to a tracked file is refused like the
tracked file itself, and the review and the report name the file the link points at.

Values are written so an expander sees the same text the source gave it. A `${HOME}` reference
read from an unquoted or double-quoted line is written in double quotes with `$` unescaped, and
a `\$` the source used for a literal dollar sign stays `\$`. Values with no quote, line break,
`$`, or backtick are single-quoted. A Value is also single-quoted, so every reader takes it
literally, when the file being replaced single-quoted it, or when it holds a `$` that is not a
variable reference (`$(command)`, `$2b$10$…`, a trailing `$`), unless it also holds a single
quote. A pulled file is data for a dotenv loader: do not `source` it in a shell, which would
expand references in double-quoted Values; use `dotrelay run` to start a command with the Values. Inside double quotes `\n`, `\r`, `\t`, `\\`, `\"`, and
`` \` `` are decoded, and any other backslash sequence, such as `"C:\Users"`, is kept as
written. Parse errors name the file.

`run [--environment <label>] -- <command> [<argument>…]` decrypts the Environment in memory and
starts the command with the Values as environment variables. Nothing is written to disk. Values
replace variables of the same name already set in the shell. Everything after `--` belongs to the
command, so its flags are never read as DotRelay flags. `run` returns the command's exit code
(128 plus the signal number when a signal ended it) and passes `SIGINT`, `SIGTERM`, and `SIGHUP`
on to it. A Value this Device cannot decrypt, or a required Variable with no value, stops the run
before the command starts.

Any active Member can publish a Variable, and some names control how a program, its loader, its
interpreter, or a shell starts rather than configuring the application: `PATH`, `HOME`,
`NODE_OPTIONS`, `NODE_PATH`, `BUN_OPTIONS`, `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`,
`PROMPT_COMMAND`, `PS1`, `PS4`, `IFS`, `PYTHON*`, `PERL5*`, `RUBYOPT`, `RUBYLIB`,
`JAVA_TOOL_OPTIONS`, `GIT_*`, `npm_config_*`, `EDITOR`, `PAGER` and similar. A Member who sets
one of these could run code as every teammate who starts a command through DotRelay. `run`
therefore refuses such a Variable (`process_control_variable`, exit 2) and names it; check who
set it with `history`, and pass it on deliberately with `--allow-env <name>`, once per name
(`dotrelay run --allow-env NODE_OPTIONS -- node app.js`). Names are matched case-insensitively.
`pull` writes these Variables like any other, but warns the first time one appears in the output
file, because loading that file into a shell or a process manager passes it on.

`export --format dotenv|json|shell` prints the decrypted Values to stdout (dotenv by default) and
writes nothing to disk. Like `pull --stdout`, terminal stdout requires `--reveal`. `--format json`
is a data format that contains the Values; it is not the `--json` diagnostic mode, which never
does. `--format shell` prints statements meant to be evaluated, so it refuses the same
process-control Variables as `run` unless each is named with `--allow-env <name>`. `list` prints each Variable's name, ownership, and whether this Device has a Value for it,
never the Values.

`diff` compares `.env` with the decrypted Environment and prints added, updated, and removed
Variables as names, ownership, and change types, with no Values. `--reveal` prints the unified
Value diff for that one run instead. Unchanged Variables are omitted. `--from <dotenv>` selects
another file. JSON reports only names and counts, with or without `--reveal`. Optional
Variables with no value are omitted and counted. A required Variable with no value, or a Value
this Device cannot decrypt, fails the comparison before any output is written and names the
Variables.

`history` renders the verified Revisions in a readable form: each Revision gets a `#ordinal`,
a readable UTC date, its mutation (Genesis, Update, or Rollback, naming the target Revision
when one is set), a marker on the current head, and the Variables the Revision added,
removed, or changed (name, ownership, and whether the Value changed). It never shows
Values. `history --json` keeps the documented revision metadata — id, mutation, Project
epoch, authored-at milliseconds, and rollback target — for automation.

`rollback` names the target Revision by its id or by the `#ordinal` that `history` shows,
and `--variable` names the Variables to roll back by operator-visible name or stable id;
names resolve against the live Manifest, so an operator never has to lift internal ids out
of encrypted protocol objects. Run `rollback` bare to render the history and choose the
target Revision and the Variables (comma-separated names, or `all`) from it. Under
`--no-input` the target Revision and at least one `--variable` are required. A rollback
never rewrites or removes earlier history: it appends a new signed Rollback Revision for
the selected lanes, preserving all other current Values. The final review is masked and
names that append-only consequence; `--reveal` shows the unified Value diff in it instead.

## Output and automation

Every command validates its complete argument contract before authentication or writes: unexpected
positionals (such as `dotrelay pull production`), flags the command does not consume, missing flag
values (including when the next token looks like another flag), and conflicting output choices are
rejected with a correction and the command's usage. A single unexpected positional on a command that
accepts `--environment` suggests passing it as `--environment <environment-id-or-label>`; `pull --stdout`
conflicts with both `--output <file>` and `--json` because Values never appear in JSON output, while
`pull --output <file> --json` reports a safe summary. An invalid invocation performs no external
mutation and writes no output file.

Protected Values are never included in status, ordinary progress, JSON responses, or diagnostics.
Human stderr is the next action. `--json` diagnostics contain category, code, sanitized detail,
exit code, and non-secret counts only. `--debug` replaces opaque unexpected-error detail with the
sanitized operational message. When the Server Profile rate-limits a request (`rate_limited`), the
CLI retries within its budget and then names the wait the service asked for, such as `wait 2
minutes and retry`; `--json` diagnostics carry it as `retryAfterSeconds`. A Team that has reached
its limit of pending invitations reports `pending_invitation_limit` (exit 4).

During `setup` and `login`, `--json` mode emits one authorization event to stderr as soon as the
device code is issued, before the final result, so an external UI can present the sign-in and
complete the login: `{"ok":true,"event":"device_authorization","userCode":...,"verificationUri":...,"intervalSeconds":...,"expiresInSeconds":...}`.
`verificationUri` is the validated URL to open and `userCode` is the code to enter; the device
code itself is never emitted. When the browser launcher fails or exits nonzero, the run also
emits a `browser_open_failed` diagnostic and keeps polling. The final result on stdout remains a
single JSON document and also carries `verificationUri` and `userCode`.

`pull --output <path>` is the explicit file path and is written only after a complete export is
ready, using an atomic replace and mode `0600`. `pull --stdout` is explicit and refuses terminal
output unless `--reveal` is also supplied. `--no-input` never prompts, guesses, or approves:
`--force` is the narrow, documented approval that lets automation replace a differing pull output
file or publish removed Variables, and it is the only flag that does (a pull that would drop
changes not yet pushed also needs `--discard-local`); it never overrides the refusal of a
Git-tracked pull output. Automation is limited to a
previously authenticated, enrolled persistent Device with explicit profile context.
Portable plaintext or environment-variable credential bundles and auto-approved ephemeral Devices
are not supported.

`status` prints a short card: Server Profile, Origin, Session, Device, and, inside a linked
worktree, the Repository, Project, and Environment, ending with a state line or the next command
to run. When the selected Project owes a key rotation, the card adds the same advice line that
protected commands print. In a worktree this machine has not linked yet, it suggests `dotrelay pull` (when a
teammate already published the Repository) or `dotrelay init`. Without a Server Profile it names
`dotrelay setup https://api.dotrelay.dev`, the hosted service; a self-hosted installation uses its
own origin. It never dumps key:value local state.

The first Device uses the server's initial trust bootstrap and stores the encrypted Device bundle
in the local credential store, with a protected local record for its profile and Device id.
The browser is a separate Device. Bootstrap is first-Device-only, so once the User already has
an active Device, a new installation or browser joins through enrollment instead: it generates
its keys and self-starts the enrollment, and one of the User's existing Devices (which may be
the only one) approves it.
`device enroll` bootstraps the first Device, or self-starts that enrollment when the User
already has one; the explicit form is `device begin --output <request>`. Move the signed
request artifact to an existing authorized installation and run `device approve --from
<request>`, which activates the new Device. Return the request artifact to the new
installation and run `device complete --from <request>`.
The request contains public protocol objects only; the pending private bundle stays in encrypted
local Device storage. When the approving Device holds the Account Master Key, `device approve` also
adds the new Device to the account's signed Device roster with the keys from the request.

`device transfer` seals the Account Master Key to another Device of this account. It uses the
keys the account's signed roster lists for that Device. A Device not listed yet is shown with the
key fingerprint the Server Profile reports; compare it with `device list` on that Device, and
answering yes adds it to the roster before the key is sealed. `--no-input` refuses a Device the
roster does not list. The command prints a transfer code: the transfer id, a dot, and this
account's fingerprint.

Create a Recovery Code with `device backup`. The 13x4 code is printed once and is the only
output; it unlocks the account's Account Master Key and is the only recovery path that works on
a headless machine. A new code invalidates the previous one, so store it somewhere safe.
`device recover` unlocks this Device from a Recovery Code or an Account Key Transfer. The
Recovery Code is entered at a hidden prompt, piped on stdin, or read from `--recovery-code-file
<path>` (a regular 0600 file, never a symlink); it is never placed on the command line and never sent to the Server
Profile. Recovery uses the Server Profile's account-key routes and never falls back to initial
bootstrap. `--no-input` requires an explicit profile and a `--recovery-code-file` or `--transfer`
channel, and never answers a prompt on the user's behalf. `device recover --transfer <code>` takes
the whole transfer code the sending Device printed. It accepts the key only when the account's
signed roster lists the sending Device and this one, and only when the key's account fingerprint
matches the code. A bare transfer id shows the fingerprint and asks; `--no-input` refuses it.

## Using DotRelay in CI and deploys

The supported pattern is a persistent runner: a machine (or a container with a persistent volume
for `DOTRELAY_CONFIG_DIR`) that a person signs in and enrolls once, like any other Device:

1. On the runner, run `dotrelay setup https://api.dotrelay.dev` (or your own origin), or
   `dotrelay login --profile <name>` for a saved profile. Sign in as the account the runner acts
   for, and unlock the Device with `dotrelay device recover` if the account already has one.
2. Make sure that account can read the Project. A dedicated account must be a Team Member whose
   keys an owner or admin shared with `dotrelay team share-keys` or **Share project keys**.
3. In the job, name everything explicitly and never prompt:

   ```sh
   dotrelay pull --stdout --no-input --profile ci --environment production > .env
   # or, with nothing written to disk:
   dotrelay run --no-input --profile ci --environment production -- ./deploy.sh
   ```

Limits today: there are no access tokens, service accounts, or ephemeral Devices. A job cannot
bring credentials in an environment variable, and every runner is a long-lived Device with its own
keys in its state directory, so treat that directory like any other secret store. When a runner
is retired, revoke its Device in the web app.

The stable exit categories are invocation/configuration (2), incomplete export (3), unresolved
conflict (4), cryptographic/integrity/compatibility (5), authentication/device/authorization (6),
transient service (7), and local I/O/credential-store (8).
