# CLI redesign prototypes (throwaway)

Three looks for the `dotrelay` CLI, built to pick a direction before the
rewrite. Nothing here talks to a server or touches disk outside `out/`, and
none of it ships: the CLI build and typecheck only include `src/`. Delete this
folder once a direction is chosen.

## Try them

```sh
bun apps/cli/prototypes/run.ts                   # pick a direction and scene
bun apps/cli/prototypes/run.ts plan first-run    # one scene; you answer the prompts
bun apps/cli/prototypes/run.ts live all --auto   # every scene, answered for you
bun apps/cli/prototypes/run.ts quiet push --width 46
NO_COLOR=1 bun apps/cli/prototypes/run.ts plan status
bun apps/cli/prototypes/run.ts quiet pull | cat  # no TTY: no prompts, exit 6
```

`bun apps/cli/prototypes/record.ts` writes `out/gallery.html`, a page that
replays every scene in every direction at 80 and 46 columns, with and
without colour. Open it in a browser.

Choices that don't change the story (picking "Another server", a recovery
code instead of a transfer code) are accepted but the scene carries on as if
you'd taken the main path.

## Directions

- **A, Quiet.** Plain sentences, a `✓` per finished step, `[Y/n]` prompts.
  Closest to today's CLI and the cheapest to build.
- **B, Live.** A rail down the left edge joins every step of a run. It has
  spinners with timings, progress bars, inline toggles, and a change table on
  push that you classify in place.
- **C, Plan.** Before doing anything the command works out what's missing and
  shows it as a checklist. The run is that one list, redrawn in place, and
  prompts open under the step that needs them. Without a TTY the same list
  prints once, so a CI log shows the step it stopped at.

## Scenes

| id           | what it shows                                                        |
| ------------ | -------------------------------------------------------------------- |
| `first-run`  | `pull` on a new machine: server, GitHub, device, account key, pull   |
| `signed-out` | `pull` with an expired session: sign in, then the pull carries on    |
| `push`       | three changes, one new name to classify, confirm, publish            |
| `status`     | everything ready except `.env`, which is a revision behind           |
| `failure`    | the connection drops mid-pull; nothing written; retry                |
| `ci`         | `--no-input` and `--json`: a stable code, exit code and next command |

## Files

- `kit.ts`: output, colour, live regions, keys, reflow for narrow terminals,
  and a virtual clock for recording.
- `quiet.ts`, `live.ts`, `plan.ts`: one file per direction, same six scenes.
- `data.ts`: the fake project, values and changes every direction uses.
- `screen.js`: a small screen model that replays recordings for the gallery.
- `record.ts`, `gallery.template.html`: the recorder and player page.
