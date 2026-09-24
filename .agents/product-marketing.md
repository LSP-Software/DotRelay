# Product Marketing Context

**Document version:** v1
**Last updated:** 2026-09-24

Context derived from the current repository truth (README, CONTEXT.md glossary,
`docs/wiki/`, ADRs, `docs/administration.md`, `docs/web-application.md`). It is a
copy guide, not a source of product claims: any statement here that the
implementation contradicts is wrong.

## Product Overview

**One-liner:** DotRelay shares revisioned environment configuration between a
team's devices without the service that synchronizes it ever seeing the values.

**What it does:** Developers publish encrypted Environment Variables from the CLI
(`dotrelay init` / `push`) and read them back on any of their authorized Devices
(`pull`), or manage them in the browser. The service stores and synchronizes
ciphertext only: Values are end-to-end encrypted with the classical v3 Web
Crypto suite (X25519, Ed25519, HKDF-SHA-384, AES-256-GCM, SHA-384). Accounts
sign in with GitHub; every device that reads content is an explicitly authorized
Device protected by the user's Account Master Key and optional recovery
wrappers.

**Product category:** secret management for environment configuration.

**Product type:** open source (AGPL-3.0) self-hostable service + hosted
deployment + CLI + web app.

**Business model:** AGPL open source; hosted and self-hosted deployments. No
paid tiers, no pricing page claims.

## Target Audience

**Target companies:** any team that already keeps environment configuration in
`.env` files and needs the same values on more than one machine — small to
mid-size engineering teams first.

**Decision-makers:** engineers and engineering leads who own deployments; the
tool earns its place through the CLI, not a sales page.

**Primary use case:** "my `.env` exists on my laptop, but the staging box, my
teammates, and my CI all need the same values without me copying secrets or
committing a file."

**Jobs to be done:**

- Get the same encrypted Environment values onto a new machine or teammate's
  machine, with the service unable to read them.
- Publish changes and roll them back with a verifiable Revision history.
- Keep per-person (User-defined) values in the same Variable set as the
  team-shared ones, without a second system.
- Recover access when a machine is lost, using a recovery method the user
  controls (Recovery Code, encryption password, passkey, or device transfer).

**Use cases:**

- A developer on a second laptop: sign in, enroll the machine, `pull`.
- A teammate joining a team: owner invites by GitHub identity, keys are
  provisioned, the teammate pulls the same Environments.
- Rotating a credential: edit in the browser or CLI, publish, every Device
  picks it up on next `pull`.
- Losing a machine: revoke the Device, recover the Account Master Key on a new
  one from a Recovery Code, `pull` everything, including User-defined Values.

## Personas

| Persona | Cares about | Challenge | Value we promise |
|---------|-------------|-----------|------------------|
| The operator (primary user) | not leaking a secret, not being locked out, boring reliable commands | `.env` copied over SSH, committed by accident, or lost with the laptop; secret managers that make the service a reader of every secret | values stay encrypted end to end; every device is explicit and revocable; the CLI names the exact next command after any failure |
| The teammate | onboarding in minutes, clear permissions | asking around for credentials; not knowing who changed what | invited by GitHub identity; Revisions say who changed which Variables; role-based visibility |
| The reviewer/auditor | what the service actually stores | vendors claiming E2E while caching or logging plaintext | the service stores ciphertext + hashes only; the claim is checkable against the code and the crypto test vectors |

## Problems & Pain Points

**Core problem:** environment configuration is the most-copied, most-leaked
artifact in a codebase, and most tools that "centralize" it make the central
service a holder of the plaintext.

**Why alternatives fall short:**

- Plain `.env` + git: secrets in VCS history, per-machine drift, no rollback
  history, no per-person values.
- Cloud secret managers: the service decrypts and dispenses values to the
  client; every reader needs an API credential; the blast radius is the
  service's database.
- Password managers: great for a single person, weak for team-shared
  environment configuration with revision history.

**What it costs them:** leaked credentials, downtime while a new machine is
configured, and secrets stuck in chat history or VCS.

**Emotional tension:** "if I put this in the tool, does the tool now hold my
secrets?"

## Competitive Landscape

**Direct:** 1Password/other secret managers with env-file integration — falls
short on team-shared, revisioned environment configuration with per-user
values in one Variable set.
**Secondary:** cloud secret managers (HashiCorp, AWS, GCP) — falls short
because the service is the decryption point and readers need service
credentials.
**Indirect:** `.env` in git with rotation discipline — falls short on
accidental commits, per-machine drift, and history.

## Differentiation

**Key differentiators:**

- The synchronizing service never decrypts: it stores and relays ciphertext
  (Account Key Envelopes, lane ciphertext, grant ciphertext).
- Devices are first-class, individually authorized, revocable clients; the
  same user's browser and CLI are distinct Devices.
- One Variable model covers both Shared Values and User-defined Values, with
  revisioned history and rollback.
- Recovery is the user's design choice: Recovery Code, encryption password,
  passkey (where WebAuthn PRF is available), or device transfer — none are
  required, and all protect the same Account Master Key.

**How we do it differently:** encryption happens entirely on the client
(Devices and browsers) with the Account Master Key; the service is a
synchronization and authorization layer over ciphertext.

**Why that's better:** the trust question becomes "can I trust this service
with ciphertext and key-wrapping operations?" rather than "can I trust it
with my secrets?"

**Why customers choose us:** developers can verify the claim by reading the
protocol code and the pinned crypto test vectors; self-hosting removes the
third-party database question entirely.

## Objections

| Objection | Response |
|-----------|----------|
| "It's classical crypto, not post-quantum" | True, and stated plainly: the v3 suite provides no post-quantum resistance; the research docs cover the migration path. |
| "GitHub is my only sign-in" | The identity boundary is GitHub; a separate Encryption Password and Device keys protect the data, so a GitHub token alone never unlocks Values. |
| "If I lose my Recovery Code and every device, I'm locked out" | That is the honest failure mode; the UI and CLI state it when the code is generated. Storing the code is the user's deliberate act, shown once. |

**Anti-persona:** teams that need the service to read or dispense plaintext
(e.g., a secret manager for a non-client application that cannot do crypto);
users who want a single shared "admin can see everything" model.

## Switching Dynamics

**Push:** secrets found in git history; the same `.env` maintained on N
machines; onboarding friction for new teammates.
**Pull:** E2E encryption with a checkable claim; one Variable set for shared
and per-person values; CLI that names the exact next step.
**Habit:** `.env` is muscle memory; cloud secret managers are already wired
into CI.
**Anxiety:** "does this new tool now hold my secrets?" and "what happens to
our values if the hosted service disappears?" — self-hosting and the AGPL
license answer the second; the crypto model answers the first.

## Customer Language

**How they describe the problem:**

- "I have the same `.env` on five machines and I'm scared to commit it."
- "How does my teammate get staging without me pasting secrets in Slack?"
- "Which service here can actually see my secrets?"

**How they describe the solution:**

- "the server only ever sees ciphertext"
- "pull gives me the same `.env` on the new machine"
- "each machine is a device I approve"

**Words to use:** Team, Project, Environment, Variable, Shared Value,
User-defined Value, Device, Revision, Rollback, Publication, Recovery Code,
encryption password, passkey, Account Master Key (only when the user needs
the term — e.g. the recovery area), Server Profile, Repository.

**Words to avoid:** "seamless", "streamline", "empower", "leverage",
"secure by design" (state the mechanism instead), "vault", "secrets
manager" as a category claim (say what it does), "one-click".

**Glossary:** see `CONTEXT.md` at the repository root — it is the canonical
term dictionary, including the `_Avoid_` list for every term. Copy must use
those terms exactly and must not use the listed alternatives.

## Brand Voice

**Tone:** developer-to-developer; plain, precise, understated.

**Communication style:** concrete mechanisms and consequences, not benefits
for their own sake; short sentences; the exact command or action the user
runs next.

**Brand personality:** competent, frank, no hype, honest about limits.

## Proof Points

- Ciphertext-only storage is structural, not a promise: protocol objects
  store canonical bytes and SHA-384 digests; pinned test vectors in
  `test-vectors/e2ee` verify the suite against source.
- Classical v3 suite through native Web Crypto, classical-only by explicit
  choice (ADR 0001); no post-quantum claims.
- AGPL-3.0: the service code can be audited and self-hosted.

## Goals

**Primary business goal:** teams adopt `dotrelay pull` into their day-to-day
environment workflow.

**Key conversion action:** a developer runs `dotrelay setup <origin>` on a
second machine (or a teammate accepts an invitation) and pulls real values.

**Current metrics:** not tracked in this repository.
