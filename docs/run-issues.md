# Unattended issue runner

Run `./run-issues.sh` from a clone of `LSP-Software/DotRelay`. It selects open,
unassigned `ready-for-agent` issues with an explicit `Priority: P<number>` and zero
native GitHub dependency blockers. Lower priorities and issue numbers run first.
It implements each issue, opens a PR, checks CI and reviews, repairs failures, and
merges the expected commit. Bun, Bash, Git, GitHub CLI, jq, OpenCode, and `ps` are
required. Authenticate GitHub CLI and configure OpenCode before starting. Keep
Tailscale connected if your model provider uses a Tailscale endpoint.

`ready-for-human` issues are handled separately by the panel's persistent grill-with-docs lane. See
[`docs/run-issues-panel.md`](run-issues-panel.md) for the interview and promotion workflow.

The controller runs the checked-out scripts. Commit these script changes before
starting a long run, and avoid editing the controller files while it runs.
OpenCode uses `--auto` in each issue checkout, as in the previous runner.

```sh
./run-issues.sh
./run-issues.sh --status
./run-issues.sh --retry 85
```

`--status` reads the saved journal, including reasons for deferred or blocked
issues, while another controller is running. `--retry` resets the saved failure
and repair budgets for that issue and starts the queue. It preserves its branch,
commits, and unfinished files. It only accepts an issue already in the journal.

On macOS, `caffeinate -i ./run-issues.sh` keeps the Mac awake during the run.
For a session that survives terminal disconnection, run it inside `tmux` or a
service manager. The runner itself does not prevent system sleep.

## Recovery and isolation

The common Git directory contains `issue-runner/state.json` and one
`issue-runner/issue-N/checkout` clone per issue. In a normal clone these are under
`.git/`. These checkouts persist through crashes and restarts. The controller
does not switch branches, stash changes, or reset files in your original working
directory. It copies committed local branch work when adopting an old issue.
Uncommitted changes in your original checkout are not copied. Finish or commit
those before resuming an old issue whose work they contain.

The journal is saved before claiming an issue. Restarting resumes claims made by
this controller even if no PR exists yet. It also adopts eligible issues assigned
to you when an `agent/issue-N` local branch or your matching open PR exists.
It does not adopt arbitrary issues assigned to you. Claims left by the old
runner with neither a branch nor a PR need manual inspection.

Each clone has its own working tree, index, and Git directory. Untracked `.env`
files, local Git configuration, and installed dependencies are not copied.
Provide required service configuration through the environment; the agent must
install dependencies in its checkout when needed. Logs and clones can contain
sensitive material from agent output and take significant disk space. They are
retained for diagnosis and are not deleted automatically.

Worker transcripts and raw OpenCode events are in each checkout's
`.git/opencode-runs/`. The journal records the tail of the last failure. Code
repair counts and advisory review acknowledgements are saved in each issue's
`worker.json`.

Retryable OpenCode errors, detected network errors, missing/delayed checks, and
command deadlines defer the issue with exponential backoff. Outages do not spend
its implementation failure budget. Other eligible issues can run in the meantime.
When a session times out, the wrapper stops its process tree before returning.
Ctrl-C or SIGTERM stops the current work; restart the command to resume it.

Repeated task failures block that issue locally and let the queue continue.
Human changes-requested reviews, closed PRs, and unfinished work on an unexpected
branch require inspection. The issue remains assigned and its checkout remains
available. A drained queue exits with status `0` if there are no local blockers,
or `2` if issues need intervention. Configuration and controller failures exit
with status `1`. Persistent outages keep the process waiting until recovery or
interruption. Issues excluded by readiness, priority, assignment, or dependency
rules are not counted as resolved.

Only one controller runs per common Git directory. A live lock prevents another
run. Dead PID locks are reclaimed; a lock without a valid owner is left for
inspection. Separate clones on other computers do not share this lock. GitHub
assignment has no atomic claim operation, so run only one issue controller for
this repository at a time. The runner rechecks ownership after assignment to
detect competing claims by other users.

## Merge gates

Project CI must appear and reach a stable successful or skipped state. The
runner pins the PR head while polling and at merge. It checks base, branch,
draft status, cross-repository status, and the exact `Closes #N` line. Conflicting
or outdated branches enter repair. Human changes-requested reviews block merging.
CodeRabbit remains advisory, with a repair opportunity for a request on the
current commit. Failed workflow reruns and no-change repairs remain bounded.

The default merge respects GitHub branch protection. The old unconditional
administrator bypass is now an explicit `MERGE_ADMIN=1` option. Configure GitHub's
required checks to prevent merging before a required job registers. Leave the
override off for unattended runs. Branches are retained after merge so local
recovery does not depend on branch deletion succeeding.

No automation can guarantee that every issue can be resolved without a product
decision, working credentials, or available infrastructure. This runner preserves
work and reports those limits instead of treating a stopped queue as success.

## Configuration

All durations below are seconds.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_BRANCH` | `main` | PR target |
| `MERGE_METHOD` | `squash` | `squash`, `merge`, or `rebase` |
| `MERGE_ADMIN` | `0` | Explicit branch-protection bypass |
| `OPENCODE_MODEL` | OpenCode default | Provider/model selection |
| `OPENCODE_AGENT` | OpenCode default | Agent selection |
| `MAX_SESSION_ATTEMPTS` | `3` | Fresh sessions before deferring an issue |
| `SESSION_RETRY_DELAY` | `10` | Delay between fresh sessions |
| `SESSION_TIMEOUT` | `3600` | Maximum time per OpenCode session |
| `COMMAND_TIMEOUT` | `120` | Maximum time per Git/GitHub command |
| `ISSUE_TIMEOUT` | `21600` | Maximum time per worker attempt, including CI |
| `MAX_ISSUE_ATTEMPTS` | `3` | Task failures before local blocking |
| `ISSUE_RETRY_DELAY` | `300` | Delay after a task failure |
| `OUTAGE_RETRY_DELAY` | `60` | Initial outage retry delay |
| `OUTAGE_RETRY_CAP` | `1800` | Maximum outage retry delay |
| `MAX_REPAIR_ATTEMPTS` | `5` | Persisted successful repair-session budget |
| `GH_RETRY_ATTEMPTS` | `6` | Worker command/read attempts |
| `GH_RETRY_DELAY` | `2` | Initial worker command retry delay |
| `CHECK_DISCOVERY_TIMEOUT` | `600` | Time for CI checks to appear |
| `CHECK_TIMEOUT` | `7200` | Time for CI to finish in one worker attempt |
| `CHECK_POLL_INTERVAL` | `10` | CI and merge polling interval |
| `CHECK_SETTLE_SECONDS` | `30` | Wait for late-registering CI jobs |
| `CI_RERUN_START_TIMEOUT` | `180` | Time for a workflow rerun to register |
| `MERGE_TIMEOUT` | `3600` | Time to confirm the merge |
| `ISSUE_CLOSE_TIMEOUT` | `300` | Time to confirm linked issue closure |
| `ADVISORY_CHECK_REGEX` | `^CodeRabbit$` | Checks excluded from project CI |
| `ALLOW_NO_CHECKS` | `0` | Explicitly allow a repository without CI |
| `LOG_VIEW` | `pretty` | `pretty` or raw `json` output |

Run `bun run test:runner` for regression tests. They use temporary Git repositories
and fake GitHub/OpenCode commands. They exercise the real controller and worker
without modifying live issues or PRs.
