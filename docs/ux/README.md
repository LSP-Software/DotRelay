# DotRelay UX improvement process

This directory holds persistent state for the DotRelay UX improvement process.

The process is browser-driven: a future session experiences the real running
application, audits it against structured methods, makes implementation
changes, and verifies the changes in the browser again. The toolchain (skills,
browser, how to start the app) is documented in [TOOLING.md](TOOLING.md) —
read it first.

## Intended files (created by audit sessions, not pre-populated)

| File | Purpose |
| --- | --- |
| `PRODUCT.md` | Durable product truth for UX work (target user, jobs-to-be-done, security truths, precise terminology, established decisions). Created 2026-09-24 from the repository record; re-ground whenever the implementation moves. |
| `JOURNEYS.md` | The user journeys the audits walk end-to-end in the browser (entry, steps, states, completion criteria). |
| `BACKLOG.md` | The prioritised, evidence-linked backlog of findings: severity, journey/step, evidence, owning skill, status. |
| `DECISIONS.md` | Decisions made during UX work (approaches taken, tradeoffs, rejected options) so later sessions don't relitigate. |
| `SESSION.md` | Rolling log of audit sessions: date, scope, skills used, what was checked, what changed, what remains. |
| `evidence/` | Screenshots and captured evidence referenced by findings. Transient smoke-test screenshots from tooling bootstrap are **not** kept here. |

Responsibility split (see [TOOLING.md](TOOLING.md)):

- **ux-audit skill** — journeys, flows, onboarding, IA, navigation, empty
  states, dead ends, confusing interactions; evidence-based findings with
  severity and prioritisation.
- **impeccable skill** — design guidance, UX writing, hierarchy, consistency,
  component-level UX, visual polish, interaction quality, accessibility,
  anti-pattern detection, implementation guidance.
- **Native browser** — experiencing the real app and verifying fixes.
- **Source code** — understanding why problems exist and implementing fixes;
  never a substitute for experiencing the product.
