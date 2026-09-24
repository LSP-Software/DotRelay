# Developer Audience Context

Last updated: 2026-09-24

Derived from the current product truth (CONTEXT.md, `docs/wiki/`, ADRs, CLI
help output). Context for writing about DotRelay to developers; it grants no
permission to soften security language or invent capabilities.

---

## Product Overview

| Field | Value |
|-------|-------|
| **Product name** | DotRelay |
| **One-liner** | We help teams share environment configuration across their machines without the synchronizing service reading the values |
| **Category** | CLI + self-hostable service (infrastructure / secret management) |
| **Core technology** | Bun/Turborepo monorepo: Next.js web app, Hono API, standalone Bun-compiled CLI; classical v3 Web Crypto suite (X25519, Ed25519, HKDF-SHA-384, AES-256-GCM, SHA-384); PostgreSQL + Valkey |
| **Pricing model** | Open source (AGPL-3.0); hosted and self-hosted deployments |

---

## Developer Persona

| Field | Value |
|-------|-------|
| **Primary role** | Full-stack / backend / DevOps — anyone who owns a deployment's environment configuration |
| **Seniority** | Mid to Lead; comfortable reading a protocol spec, skeptical of "E2E" claims |
| **Company size** | Startup to scale-up; enterprise as self-hosted deployment |
| **Industry verticals** | any; the problem is universal to teams with environments |
| **Tech stack** | Node/Bun/TypeScript shops first (the CLI is a compiled Bun binary), but the protocol is plain Web Crypto, so any language can interoperate |
| **Decision authority** | Individual contributor evaluates, team lead adopts |

**Day-in-the-life:**
> Maintains `.env` files for dev/staging/prod across at least two machines.
> Has committed a secret (or watched someone else). Onboards teammates by
> pasting values. Wants one place where "what is the current value of
> `API_ORIGIN` in staging" has an answer with history, and wants the service
> that answers it to be unable to read the answer.

---

## Where They Hang Out

| Channel | Specific places |
|---------|-----------------|
| **GitHub** | The repository itself; topics: secrets, dotfiles, environment, e2ee, self-hosted |
| **Reddit** | r/devops, r/selfhosted, r/webdev |
| **Hacker News** | Show HN on releases; self-hosted threads |
| **Blogs** | dev.to, personal engineering blogs about secret management |

(The repository has no social presence of its own; do not claim one.)

---

## Problems & Pain Points

### Functional problems

- The same `.env` maintained on N machines drifts; nobody knows which copy is
  current.
- Secrets committed to VCS history; rotation is a fire drill.
- Teammates can't get staging values without a human in the loop.
- Per-person values (a personal API token in the same file as shared config)
  have no home in any shared system.

### Emotional pain

- Anxiety that any centralized tool becomes a new plaintext holder.
- Distrust of "secure" claims with no verifiable mechanism.

### Trigger moments

- A second laptop or a new teammate.
- A secret found in git history.
- Choosing tooling for a new project.

**#1 frustration that brings developers to us:**
> "I don't want a service that can read my secrets — I want the same values
> on every machine, with history, where the middle box can't."

---

## Current Alternatives

| Alternative | Why devs choose it | What's frustrating | Switching triggers |
|-------------|-------------------|-------------------|-------------------|
| `.env` in git (or git-ignored + manual sync) | zero setup, muscle memory | leaks, drift, no history, no per-person values | first leak or onboarding pain |
| Cloud secret managers (HashiCorp/AWS/GCP) | enterprise integration, IAM | the service decrypts and dispenses; readers need credentials; per-user values awkward | E2E requirement, cost, self-hosting |
| Password managers (1Password et al.) | trusted, mature | shared team environment config with revision history is not the model | needing shared + personal values in one Variable set |
| Build it themselves | control | maintenance, crypto is hard to get right | finding a protocol they can audit |
| Do nothing | inertia | drift and leaks accumulate | incident |

---

## Key Differentiators

| Type | Our claim | Proof |
|------|-----------|-------|
| **Technical** | the service stores and relays ciphertext only; no plaintext column, no plaintext in logs | schema + protocol objects store canonical bytes and SHA-384 digests; pinned test vectors verify the suite |
| **Technical** | classical Web Crypto only, explicitly not post-quantum | ADR 0001; `test-vectors/e2ee` |
| **Developer experience** | one Variable set holds Shared and User-defined Values; Revisions with rollback; the CLI names the exact next command after any failure | `dotrelay help` contract; masked reviews; stable exit categories |
| **Trust** | Devices are individually authorized and revocable; recovery methods are the user's choice, none required | ADR 0009/0010/0011; the in-browser Recovery area |
| **Licensing** | AGPL open source, self-hostable, auditable | LICENSE, source, CI |

---

## Tone & Style for Developer-Audience Copy

- Developer-to-developer: plain, concise, slightly informal, confident,
  precise, understated.
- Concrete mechanisms and consequences over vague benefits: "the API stores
  the AES-256-GCM ciphertext of each Value" beats "your secrets stay safe".
- Name the exact command or action: `dotrelay pull`, `dotrelay device
  backup`, "revoke the Device", not "get back access".
- State limits honestly: classical crypto, no post-quantum resistance; a lost
  Recovery Code with all Devices lost is a lockout; revocation does not erase
  plaintext already downloaded.
- Use the CONTEXT.md vocabulary exactly (Team, Project, Environment,
  Variable, Shared Value, User-defined Value, Device, Revision, Rollback,
  Publication, Recovery Code, Server Profile). Never "seamless",
  "streamline", "empower", "leverage", "robust", "powerful", "intuitive",
  "unlock", "revolutionise", "effortless".
- No invented terminology for familiar concepts; no "not X, but Y" prose; no
  three-item slogans; no fake quotations.
- Security copy must state the consequence, not offer comfort: a revocation
  message says what the other Devices can and cannot still read.
