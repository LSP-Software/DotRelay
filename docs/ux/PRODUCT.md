# DotRelay product truth for UX work

Durable reference for UX sessions. If this file and the implementation
disagree, the implementation wins and this file is stale. The canonical term
dictionary is `CONTEXT.md` at the repository root; this file adds the
product-frame around it.

## What the product is

DotRelay is a collaboration context for sharing revisioned environment
configuration without the synchronizing service ever seeing human-readable
content. A team's Environments hold Variables, each with a Shared Value
(team-readable) or a User-defined Value (readable only by that User's Devices).
Revisions are immutable and signed; rollback appends a new Revision.

Two surfaces, one protocol:

- **CLI** (`dotrelay`): the primary surface. `setup`, `login`, `init`, `push`,
  `pull`, `diff`, `status` are the everyday commands; power commands
  (`device backup`, `device recover`, `device begin/approve/complete`,
  `project link`, `env use`, `context`, `history`, `rollback`, `profile
  add/use/list/remove`, `project rotate`) are listed by `dotrelay help`. The
  CLI is how Teams and Projects get created (`dotrelay init`); the web app
  has no team/project creation surface (decision D-002).
- **Web app**: manages the variables of existing Projects (view, edit,
  publish, rollback, history), and carries the browser Device's trust,
  session, enrollment, and the in-browser Recovery & Security area. It is a
  client of the API's Better Auth authority; the session cookie is scoped to
  the API origin.

## Target user

An experienced TypeScript/Node developer who owns environment configuration
for at least one deployment, on at least two machines, with at least one
teammate who needs the same values. They read CLI help, trust mechanisms over
adjectives, and verify claims against code.

## Jobs to be done

1. Get the same encrypted Environment values onto a new machine or a
   teammate's machine, with the service unable to read them.
2. Publish a change and see exactly which Variables changed, by whom, in
   which Revision — and roll a Variable or the whole Environment back.
3. Keep per-person values in the same Variable set as the team's, without a
   second system.
4. Recover access when a machine or Device is lost, using a recovery method
   the user set up (Recovery Code, encryption password, passkey where PRF is
   available, or device transfer).
5. Revoke a Device and understand truthfully what that does and does not do.

## Security truths (copy must never contradict these)

- **GitHub sign-in authenticates only.** It establishes the server-local
  User. It does not grant Membership, Device authority, decryption, or
  mutation permission. Copy must never say signing in "unlocks" or "decrypts"
  anything.
- **The service never sees plaintext Values, the Account Master Key, Recovery
  Codes, or passkey PRF outputs.** It stores and relays ciphertext, hashes,
  and signed protocol objects.
- **Plaintext keys never leave** a Device or browser: decryption happens in
  the client's memory. The browser holds the Account Master Key in memory
  only for the session (decision D-005); every new session re-unlocks it.
- **Revocation is logical, not erasure.** A revoked Device's and a removed
  member's *already-downloaded* plaintext cannot be erased. Copy must say so
  instead of implying cleanup.
- **Classical crypto, explicitly.** The v3 suite (X25519, Ed25519,
  HKDF-SHA-384, AES-256-GCM, SHA-384, native Web Crypto) provides no
  post-quantum resistance (ADR 0001). Do not imply forward security against
  quantum.
- **Recovery is the user's design choice.** No method is required. All
  wrappers protect the same AMK. Losing the Recovery Code while every Device
  is also lost is a lockout — state it when the code is generated.
- **Drafts never reach the service.** A Draft is client-held; only a
  Publication's signed lanes are transmitted.
- **The trust gate is per-origin and per-identity.** Clients pin the Server
  Profile id + origin after explicit trust; a changed identity at the same
  origin is an identity failure, not a silent re-trust.
- **Success messages only after the durable operation.** The CLI reports
  Published only after the finalize; the web app likewise.

## Terms that must stay technically precise

Use the `CONTEXT.md` definitions and avoid its listed alternatives. The ones
UX copy most often gets wrong:

| Term | Precise meaning | Never call it |
|------|-----------------|---------------|
| Account Master Key | the 256-bit anchor key, per User per Server Profile | master password, account password |
| Recovery Code | the one-time, human-held, 13x4 emergency secret | backup password, recovery key file |
| Encryption Password | a secret that only unlocks the AMK, never authenticates | login password, master password |
| Device | a client installation authorized by one User | session, computer, "device" for a tab |
| Publication | the staged, signed operation that creates a Revision | commit, push (in copy aimed at the concept), upload |
| Rollback | a new Revision restoring earlier content, history preserved | revert, restore, delete |
| Shared Value / User-defined Value | the two ownership kinds of a Variable's value | global value / personal value |
| Server Profile | a named hosted or self-hosted service the client selects | instance, endpoint, "environment" |
| Revision | an immutable recorded Manifest state | version, snapshot |

## Established UX decisions (do not relitigate)

See `docs/ux/DECISIONS.md`: D-001 sign-out placement; D-002 no web team
creation; D-003 member management scope (no leave-team); D-004 the recovery
state matrix; D-005 AMK in browser memory only; D-006 prebuilt argon2 worker.

## Voice

Developer-to-developer; plain, concise, slightly informal, confident, precise,
understated. Concrete mechanisms and consequences. Short headings. The exact
next command. No AI/SaaS/VC vocabulary (full reject list in the campaign
brief and in `.agents/developer-audience-context.md`). Prefer deletion over
rewrite. Security copy states consequences, never offers comfort.
