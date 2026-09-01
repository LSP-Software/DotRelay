# Standalone CLI

The `dotrelay` binary exposes the command contract. The repository also contains a private npm
selector implementation for future distribution; it is not currently published.

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

`context` normalizes GitHub SSH and HTTPS remotes to a stable owner/repository identity. Missing or
different repository remotes fail closed and require an explicit choice. Repository detection only
finds a Project; it never grants Membership or secret access. Environment selection is worktree
local. `.git/dotrelay/config` may contain only the Server Profile, Project, and Environment opaque
ids, never names or Values.

## Output and automation

Protected Values are never included in status, ordinary progress, JSON responses, or diagnostics.
`pull --output <path>` is the safe file path and is written only after a complete export is ready,
using an atomic replace and mode `0600`. `pull --stdout` is explicit and refuses terminal output
unless `--reveal` is also supplied. `--no-input` never prompts or guesses; missing Values and
conflicts fail without writing an output file. Automation is limited to a previously authenticated,
enrolled persistent Device with explicit profile and environment context. Portable plaintext or
environment-variable credential bundles and auto-approved ephemeral Devices are not supported.

The stable exit categories are invocation/configuration (2), incomplete export (3), unresolved
conflict (4), cryptographic/integrity/compatibility (5), authentication/device/authorization (6),
transient service (7), and local I/O/credential-store (8). `--json` diagnostics contain category,
code, safe detail, exit code, and non-secret counts only.
