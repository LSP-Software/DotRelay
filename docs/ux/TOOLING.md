# UX toolchain

Persistent reference for the browser-driven UX audit and improvement process on
DotRelay. Read this before doing UX work in a future session; it records the
toolchain, its verification state, and the exact commands to run.

Last verified: 2026-09-18 (bootstrap session).

## Responsibility split

The toolchain is intentionally small. Do not merge these roles or add parallel
UX/design tooling.

| Layer | Role | Owned by |
| --- | --- | --- |
| Real browser | Experiencing the running app: navigating journeys, reproducing states, clicking through flows, inspecting rendered output, screenshots, verification after fixes | Oh My Pi native `browser` eval prelude (Puppeteer-backed) |
| UX audit | User journeys, flow problems, onboarding, information architecture, navigation, empty states, missing actions, dead ends, confusing interactions, evidence-based findings, severity/prioritisation, "can the user accomplish the goal" | `ux-audit` skill |
| Design guidance | Design guidance, UX writing, visual hierarchy, consistency, component-level UX, visual polish, interaction quality, accessibility considerations, anti-pattern detection, implementation guidance | `impeccable` skill |
| Source code | Understanding why an observed problem exists; implementing fixes | normal repository work |

Source code is NOT a substitute for experiencing the product. A finding that was
not observed in the running app (or in committed evidence such as the Playwright
suite in `apps/web/e2e/`) is a hypothesis and must be labeled as one.

Expected loop for audit sessions:

```
REAL BROWSER (browser prelude)
    -> ux-audit skill (journeys, findings, evidence, severity)
    -> impeccable skill (design/UX-writing guidance per finding)
    -> implementation in source
    -> browser prelude again (verify the fix in the real app)
```

## Installed tooling

| Tool | Where | Version | Notes |
| --- | --- | --- | --- |
| Oh My Pi | `omp` v18.2.6 (global, `~/.bun/bin/omp`) | 18.2.6 | Harness for these sessions |
| Pi (standalone) | `pi` v0.85.1 (global) | 0.85.1 | Same skill runtime; `pi` also reads `.pi/skills/` (not needed here) |
| Native browser | OMP `browser` eval prelude (Puppeteer/CDP via cmux) | — | The browser implementation for this project. **Do not install pi-playwright.** |
| Impeccable | `.agents/skills/impeccable/` (project) | skill 4.3.1, launcher 4.0.0 (engine v0.1.5) | Design guidance skill + deterministic detectors + live-variant mode |
| UX Audit skill | `.agents/skills/ux-audit/` (project) | 1.4.0 | Evidence-based audit methodology, 16 dimensions, reference material, `scripts/contrast-check.py` |
| Docker | host Docker + Compose | 29.7.2 / v5.4.0 | Postgres + Valkey backing services |

### Why `.agents/skills/` and not `.pi/skills/`

OMP v18.2.6's skill discovery scans project `.agent/skills` / `.agents/skills`
(and their user-home counterparts), `.claude/skills/`, `.codex/skills/`,
`.github/skills/`, and `.opencode/skills/` — it does **not** scan `.pi/skills/`.
The standalone `pi` runtime does scan `.pi/skills/`, but these sessions run
under OMP, so the canonical project-skills location here is
`.agents/skills/`. Both skills are committed at that location and were verified
loadable from a fresh OMP session (see Verification below).

If a future OMP release adds `.pi/skills/` project scanning, prefer keeping the
canonical location as-is (re-verify discovery after the upgrade rather than
moving files).

## Starting the application

From the repository root:

```sh
# 1. backing services (Postgres :5432, Valkey :6379)
docker compose up -d

# 2. apply schema (idempotent)
bun x prisma migrate deploy --config packages/database/prisma.config.ts

# 3. full dev stack (web :3000, API :3001) — long-running, use hub op:start
bun run dev
```

`bun run dev` runs `turbo run dev --parallel`: Next.js web (`apps/web`, port
3000) and the Hono API (`apps/api`, port 3001). The web app loads the root
`.env` itself (see `apps/web/next.config.ts`) and defaults its live API origin
to `http://localhost:3001` (`apps/web/lib/workspace-boundary.ts` →
`resolveLiveApiOrigin`).

Expected local URLs:

- Web app: `http://localhost:3000/` (landing), `/sign-in`, `/workspace`, `/device`
- API: `http://localhost:3001/api/v1/...` (capabilities, session, boundary)

Health probe:

```sh
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/   # 200
curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/api/v1/capabilities  # 200
```

## Browser usage (Oh My Pi native)

Use the `browser` object from the `eval` prelude (JavaScript or Python).
Verified capabilities (2026-09-18):

- `browser.open({ name, url, persist: true })` — open a tab; use `persist: true`
  so the tab survives across turns
- `tab.observe()` — element list with `id`s (`tab.id(e1).click()`)
- `tab.ariaSnapshot()` — full ARIA/accessibility tree (roles, refs, URLs)
- `tab.screenshot({ path })` — note: on the cmux surface `fullPage: true` is
  unavailable; screenshots are viewport-only (1798x2080 source at 2x)
- `tab.click("text/...")` / `tab.fill` / `tab.select` / `tab.press` — interaction
  (text entry, select, click all verified against a local fixture)
- `tab.goto(url)` / `tab.waitForSelector("text/...")` — navigation and state waits
- `tab.evaluate(fn)` — must be **synchronous** on this surface (no top-level
  `await`); for async page work use `tab.run(async ({ tab, page }) => { ... })`

Known limitations (work around, do not "fix" with new packages):

- `data:` URLs are intercepted by the relay browser (redirected to a search
  engine). Serve test fixtures from a real local HTTP server instead.
- Console-message capture is not exposed on the `browser` prelude in this
  version. Use `tab.evaluate`/`tab.run` DOM probes, the Network-visible API
  (`/api/v1/...` endpoints), or the repo's Playwright e2e suite
  (`bun run test:e2e`) for console-level evidence.
- Element refs from `tab.observe()` go stale after navigation or re-render;
  re-observe, then act, in the same eval call.

`pi-playwright` is **not installed** and should not be installed: native browser
automation passed the full smoke test against the running app.

## Invoking the skills

In an OMP (or `pi`) session started from the repository root, both skills are
discovered automatically (project-trusted). Use:

- `/skill:ux-audit` (or just ask for an audit, e.g. "audit the UX of the
  sign-in to workspace flow" — the skill description triggers autoload)
- `/skill:impeccable` for design/UX-writing guidance, or a specific Impeccable
  command: `/impeccable critique <target>`, `/impeccable polish <target>`,
  `/impeccable onboard <target>`, etc. (see
  `.agents/skills/impeccable/SKILL.md` Commands table)

Skill content and assets resolve via internal URIs:

- `skill://impeccable` → the SKILL.md; `skill://impeccable/reference/critique.md`
  for a command playbook
- `skill://ux-audit` → the SKILL.md; `skill://ux-audit/references/dimensions/...`
  for dimension guides; `skill://ux-audit/references/report-template.md` before
  writing a report

### Impeccable per-session bootstrap

Once per session, from the repo root:

```sh
.agents/skills/impeccable/scripts/impeccable context --target apps/web
```

The launcher is a self-contained binary (no Node required); it resolves product
context. If it reports `NO_PRODUCT_MD`, that is expected until the audit session
runs the Impeccable `init` flow (see Product context below). Do not run broad
`polish`/`bolder` commands during an audit.

## Authentication and test users

- The app is GitHub-oAuth only (Better Auth; `GITHUB_CLIENT_ID/SECRET` are set
  in the local `.env`). The sign-in page is a single "Continue with GitHub"
  button.
- A signed-in workspace session requires an interactive GitHub OAuth callback,
  which cannot be completed headlessly. The browser toolchain **can** drive the
  user's real browser if needed (relay mode), or an audit session can exercise
  the deep journey in the user's terminal alongside.
- Local-only alternative: the development fixture. Set
  `DOTRELAY_WORKSPACE_FIXTURE=1` in the root `.env` (both the web app and the
  API read it; the web build mirrors it to `NEXT_PUBLIC_DOTRELAY_WORKSPACE_FIXTURE`),
  then restart the dev stack. It provides a Server Profile preview and
  signed-in workspace identity without GitHub, so the full workspace surface
  (manifest editor, devices, invitations, device approval at `/device?code=...`)
  can be audited locally without an account. The fixture keeps a Server Profile
  preview selector, so hosted and self-hosted behavior can both be exercised.
- Unsigned surfaces (landing, sign-in, `/device` with an invalid/expired code)
  are fully auditable without any credentials.

## Product context (Impeccable)

`PRODUCT.md` does not exist yet. The audit session should run the Impeccable
`init` flow (`.agents/skills/impeccable/reference/init.md`) to capture durable
product context in `PRODUCT.md` before any design work. It interviews the user
for material gaps it cannot infer from the repository (primary users/situation,
positioning, durable constraints) — do not invent answers. `docs/web-application.md`
and `docs/wiki/` are strong starting evidence. `DESIGN.md` is produced by
`/impeccable document` only if the session chooses to record the incumbent
visual system; it is not required for audits.

## Skill reload

Skill discovery runs at session start. After installing or moving skills,
start a **new** session (an existing session will not see new skills). No
reload command is needed. To verify discovery in a new session, ask the agent
to `read skill://impeccable` and `read skill://ux-audit`.

## Verification (bootstrap session, 2026-09-18)

- Fresh `omp -p` session in the repo root: `skill://impeccable` (name
  `impeccable`, skill 4.3.1) and `skill://ux-audit` (name `ux-audit`, v1.4.0)
  both resolved; `skill://ux-audit/references/dimensions/onboarding-and-flows.md`
  and `skill://impeccable/reference/critique.md` resolved from skill URIs.
- `.agents/skills/impeccable/scripts/impeccable context --target apps/web`
  exited 0 (reports missing PRODUCT.md — expected).
- `contrast-check.py` runs on stock `/usr/bin/python3` (no dependencies).
- Browser smoke test against the running app: opened `http://localhost:3000/`,
  `ariaSnapshot()` returned the full tree, screenshots captured (landing +
  sign-in), anchor click scrolled, navigation to `/sign-in` rendered
  "Continue with GitHub", text fill / select / click verified on a local
  fixture. No UI changes were made.

## Limitations and non-automated steps

- GitHub OAuth sign-in cannot be exercised headlessly (see Authentication).
- `impeccable live` (in-browser variant bar) is not configured; it needs
  `.impeccable/live/config.json` plus a consented CSP check against the app.
  The audit session should only set it up if live variant iteration is wanted.
- The Impeccable launcher binary at
  `.agents/skills/impeccable/scripts/bin/darwin-arm64/` is a per-machine build
  artifact (gitignored); it re-downloads on first run on other machines.
