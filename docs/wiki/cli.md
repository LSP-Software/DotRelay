# Standalone CLI

The `dotrelay` binary exposes the command contract. The `dotrelay` npm package selects the native
binary staged for the current platform and forwards the same arguments to it.

## Profiles and authentication

The first invocation has no ambient Server Profile. Use `dotrelay profile add <name> <https-origin>`
to fetch and verify `/api/v1/capabilities`, then `dotrelay profile use <name>` to choose a global
default. Adding a profile never selects it. A command-level `--profile <name>` override wins over
the global selection. The catalog stores only the exact origin and immutable server profile id; a
changed identity or origin requires an explicit trust decision.

`dotrelay login` performs Better Auth device authorization. The server supplies the user code,
verification URI, expiration, and polling interval. `--no-open` suppresses opening the browser.
Login creates a server session only and then directs the user to `dotrelay device enroll`; it does
not silently authorize a Device or receive a GitHub token. Session material and encrypted Device
bundles belong in the operating-system credential store, scoped by Server Profile.

`logout` removes the local session. `--insecure`, certificate bypasses, and token/device-key flags
are rejected.

## Repository and worktree context

`context` normalizes GitHub SSH and HTTPS remotes, then resolves GitHub's stable numeric Repository
id. Missing or different repository remotes fail closed and require an explicit choice. Repository
detection only finds a Project; it never grants Membership or secret access. The identity lookup
uses GitHub's public repository metadata endpoint and never receives a GitHub token from the CLI.
Environment selection is by opaque id and is worktree local. `.git/dotrelay/config` may contain
only the Server Profile, Project, and Environment opaque ids, never names or Values.

`project link --team <team-id>` sends the resolved numeric Repository id to the authenticated
Server Profile. It requires an authenticated session and an active enrolled Device; a session from
`login` alone is intentionally insufficient. `env use <environment-id>` reads only opaque
Environment metadata and never exposes a server-side Environment name, because the server does not
store readable names.

## Encrypted workflows

`init <environment> --from <dotenv>` creates the signed genesis Revision. `push --from <dotenv>`
appends a signed Manifest Revision. Every input Variable must be explicitly classified with
`--classify NAME=shared` or `--classify NAME=user-defined`; interactive classification is available
when those flags are omitted. Existing Variable ids are retained, omitted Variables become signed
tombstones, and empty Values remain Values rather than being dropped.

The CLI reviews the publication summary before beginning staging. It then uploads the signed
command and encrypted protocol objects, finalizes the operation with the expected head and epoch,
and cancels a failed operation when the Server Profile permits cancellation.

`pull --output <path>` and `pull --stdout` first verify the complete v3 history from genesis. A
missing Value fails the export before any output is written. Terminal stdout requires explicit
`--reveal` and confirmation; ordinary diagnostics never contain Values. `history` reports only
revision metadata. `rollback <revision> --variable <id>` creates a new signed Rollback Revision
for the selected lanes, preserving all other current Values.

## Output and automation

Protected Values are never included in status, ordinary progress, JSON responses, or diagnostics.
`pull --output <path>` is the safe file path and is written only after a complete export is ready,
using an atomic replace and mode `0600`. `pull --stdout` is explicit and refuses terminal output
unless `--reveal` is also supplied. `--no-input` never prompts or guesses; missing Values and
conflicts fail without writing an output file. Automation is limited to a previously authenticated,
enrolled persistent Device with explicit profile and environment context. Portable plaintext or
environment-variable credential bundles and auto-approved ephemeral Devices are not supported.

The first `device enroll` uses the server's initial trust bootstrap and stores the encrypted Device
bundle in the native credential store, with a protected local record for its profile and Device id.
When an active Device already exists, `device enroll` begins the dual-control flow instead. The
explicit form is `device begin --output <request>`. Move that signed request artifact to a second
authorized installation and run `device approve --from <request>`. Return the request artifact to
the initiator and run `device complete --from <request>`. The request contains public protocol
objects only; the pending private bundle stays in encrypted local Device storage.

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
transient service (7), and local I/O/credential-store (8). `--json` diagnostics contain category,
code, safe detail, exit code, and non-secret counts only.
