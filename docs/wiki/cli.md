# Standalone CLI

The `dotrelay` binary exposes the command contract. The `dotrelay` npm package selects the native
binary staged for the current platform and forwards the same arguments to it.

Everyday commands are `setup`, `login`, `init`, `push`, `pull`, `diff`, and `status`. Power commands stay
available and are listed by `dotrelay help`.

## First machine and sign-in

The first invocation has no ambient Server Profile. `dotrelay setup <origin>` fetches and verifies
`/api/v1/capabilities`, saves that pin, selects it, signs in with Better Auth device authorization,
and enrolls the first Device on this machine. Adding a profile selects it when none is selected.
A command-level `--profile <name>` override wins over the global selection. The catalog stores only
the exact origin and immutable server profile id; a changed identity or origin requires an explicit
trust decision.

Interactive setup and `profile add` confirm trust with Enter. `--no-input` never guesses and still
requires `--accept-profile <server-profile-id>`.

`dotrelay login` reuses an existing profile: it waits on the user code, then enrolls the first
Device if this machine does not already have one. It does not start dual-control enrollment and
does not receive a GitHub token. Before it starts waiting it shows the copyable verification URL,
the user code, and the code expiry. The shown URL is validated against the pinned Server Profile
and is the one to open: when the service supplies a complete URL it already includes the user
code. `--no-open` suppresses opening the browser, and `--no-input` never attempts to open one (for
example over SSH); in both cases the same URL, code, and expiry are shown so the User can open the
URL manually. When the browser launcher is unavailable, fails to start, or exits nonzero, the CLI
shows that manual path instead of aborting and keeps polling for the authorization to complete.
Session material and encrypted Device bundles belong in the operating-system credential store,
scoped by Server Profile.

`logout` removes the local session. `--insecure`, certificate bypasses, and token/device-key flags
are rejected.

## Repository and worktree context

`context` normalizes GitHub SSH and HTTPS remotes, then resolves GitHub's stable numeric Repository
id. Protected commands use that identity to automatically find the accessible Project, so a saved
Project selection is not required when running from its repository. Missing or different repository
remotes, or an unlinked repository, fail closed and require an explicit choice. Repository
detection only finds a Project; it never grants Membership or secret access. The identity lookup
uses GitHub's public repository metadata endpoint and never receives a GitHub token from the CLI.

Environment selection is by opaque id or operator-visible label, and is worktree local.
`.git/dotrelay/config` may contain only the Server Profile, Project, and Environment opaque ids,
never Values. `--no-input` requires the profile to be supplied explicitly and does not guess a Team.

`project link --team <team-id>` sends the resolved numeric Repository id to the authenticated
Server Profile. The Server Profile creates a default Environment in the same transaction when the
Project is new, and returns the existing Project and Environment on retry. It requires an
authenticated session and an active enrolled Device; a session from `login` alone is insufficient
until this machine has a Device. `env use <environment-id>` reads opaque Environment metadata and
the operator-visible label.

## Encrypted workflows

`init` and `push` use `.env` by default. When the GitHub Repository is not yet linked, both commands
create the missing Team, Project, and Environment: the only Team is used automatically, multiple
Teams are chosen from a terminal list, and zero Teams prompts to create one (defaulting the name to
the repository owner). Use `--team <team-id>`, an opaque Environment id, or `--from <dotenv>` only
to override those defaults. If the Environment already has a genesis Revision, `init` continues as
`push` instead of failing.

New Variables must be classified as shared or user-defined. Interactive `init` shows a board of
every Variable name (never Values) and lets you toggle Team vs Only you before continuing. `push`
shows that board only for names that are not already in the Environment; existing Variables keep
their ownership. JSON and `--classify` still use `shared` and `user-defined`. `--classify NAME=shared`
or `--classify NAME=user-defined` skips the board when every new Variable is covered, and is required
under `--no-input` for unclassified names. Existing Variable ids are retained, omitted Variables
become signed tombstones, and empty Values remain Values rather than being dropped.

Interactive `init` and `push` confirm only Variables that will change. Each change is a unified
diff. The Variable name comes first, then a `-` line for the current Value and a `+` line for the
next Value. Added Variables omit the `-` line. Removed Variables omit the `+` line. The shared
prefix and suffix stay on both lines, and only the edited span is marked. Unchanged Variables are
omitted. `--no-input` skips the prompt. JSON, progress, and diagnostics still never contain Values.

Publication progress is Encrypting, Uploading, then Published. The CLI reviews the publication
summary before beginning staging. It then uploads the signed command and encrypted protocol
objects, finalizes the operation with the expected head and epoch, and cancels a failed operation
when the Server Profile permits cancellation.

`pull` writes decrypted Values to `.env` by default. Interactive `pull` confirms before replacing
an existing file, using the same unified Value diff as `push` but from the current file to the
Environment. Identical Values report that no changes were found and leave the file untouched.
`--no-input` skips the prompt. `pull --output <path>` and `pull --stdout` first verify the complete
v3 history from genesis. A missing Value fails the export before any output is written. Terminal
stdout requires explicit `--reveal` and confirmation; ordinary diagnostics never contain Values.

`diff` compares `.env` with the decrypted Environment and prints added, updated, and removed
Variables as the same unified diff, including Values. Unchanged Variables are omitted. `--from
<dotenv>` selects another file. JSON reports only names and counts. A missing Value fails the
comparison before any output is written. `history` reports only revision metadata. `rollback
<revision> --variable <id>` creates a new signed Rollback Revision for the selected lanes,
preserving all other current Values. Rollback confirmation uses the same unified Value diff.

## Output and automation

Protected Values are never included in status, ordinary progress, JSON responses, or diagnostics.
Human stderr is the next action. `--json` diagnostics contain category, code, sanitized detail,
exit code, and non-secret counts only. `--debug` replaces opaque unexpected-error detail with the
sanitized operational message.

During `setup` and `login`, `--json` mode emits one authorization event to stderr as soon as the
device code is issued, before the final result, so an external UI can present the sign-in and
complete the login: `{"ok":true,"event":"device_authorization","userCode":...,"verificationUri":...,"intervalSeconds":...,"expiresInSeconds":...}`.
`verificationUri` is the validated URL to open and `userCode` is the code to enter; the device
code itself is never emitted. When the browser launcher fails or exits nonzero, the run instead
emits a `browser_open_failed` diagnostic and keeps polling. The final result on stdout remains a
single JSON document and also carries `verificationUri` and `userCode`.

`pull --output <path>` is the explicit file path and is written only after a complete export is
ready, using an atomic replace and mode `0600`. `pull --stdout` is explicit and refuses terminal
output unless `--reveal` is also supplied. `--no-input` never prompts or guesses. Automation is
limited to a previously authenticated, enrolled persistent Device with explicit profile context.
Portable plaintext or environment-variable credential bundles and auto-approved ephemeral Devices
are not supported.

`status` prints a short card: profile, origin, signed-in, Device enrolled. It never dumps key:value
local state.

The first Device uses the server's initial trust bootstrap and stores the encrypted Device bundle
in the native credential store, with a protected local record for its profile and Device id.
The browser is a separate Device. Session bootstrap may enroll it after the CLI is already active.
`device enroll` still begins the dual-control flow when adding a Device whose keys are generated on
an already enrolled installation. The explicit form is `device begin --output <request>`. Move that
signed request artifact to a second authorized installation and run `device approve --from
<request>`. Return the request artifact to the initiator and run `device complete --from <request>`.
The request contains public protocol objects only; the pending private bundle stays in encrypted
local Device storage.

Create a Recovery Kit with `device backup --output <path>`. The protected file contains the kit and
the public key needed to verify its signed envelope. It is never printed in normal or JSON output.
When replacing an existing path, the prior protected artifact is retained at `<path>.previous` so a
failed publication cannot remove the last usable Recovery Kit.
`device recover --from <path>` verifies the profile, User, envelope signature, decryption, fresh
challenge proof, replacement keys, and certificate before sending the recovery request. Recovery
requires no active Device on the Server Profile and uses `/api/v1/recovery/restore`; it never falls
back to initial bootstrap. `--no-input` requires an explicit profile and all required handoff paths,
and never answers a confirmation prompt on the user's behalf.

The stable exit categories are invocation/configuration (2), incomplete export (3), unresolved
conflict (4), cryptographic/integrity/compatibility (5), authentication/device/authorization (6),
transient service (7), and local I/O/credential-store (8).
