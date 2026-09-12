# Issue runner panel

The issue runner panel is a private local dashboard for `run-issues.sh`. It shows the current runner
stage, active issue and pull request, process health, elapsed time, recent runs, and a live controller
transcript. It can also start the runner or request a graceful stop.

The human lane keeps one unassigned, prioritized `ready-for-human` issue prepared with
`/grill-with-docs`. It uses a persistent checkout and resumes the same OpenCode session after each
answer, so the interview context and its `CONTEXT.md`/ADR writes survive between browser visits.
Questions that the codebase can answer are delegated to the agent; the panel only presents product
and domain decisions that need a human.

The controller writes an atomic status document and one combined transcript per invocation in
`.git/issue-runner/`. The panel reads that controller directory and its queue journal directly; it
never executes shell commands or changes runner state. Per-issue checkpoints and private checkouts
remain under `.git/issue-runner/issue-N/` and are not exposed by the panel.
Grill state, transcripts, and checkouts live under `.git/issue-runner/grill/` and are likewise not
exposed through a file or log endpoint.

## Human grill workflow

Opening the panel starts preparation of the highest-priority unassigned `ready-for-human` issue when
there is no grill already in progress. The agent runs one question round and waits. Use **Send
answer** for another round. When the shared understanding is complete, use **Finish & prepare
ticket**; the current textarea can contain a final answer or be empty.

Finishing resumes that exact session and hands it to `/to-spec`. The agent must preserve precise
answers in the existing issue, verify the domain-doc artifacts, publish and merge a documentation PR
when the checkout changed, then replace `ready-for-human` with `ready-for-agent`. The panel verifies
the final labels, non-empty issue body, and clean checkout before considering the grill complete. It
then prepares the next human issue. A failed turn remains visible and requires **Retry**; it is never
silently promoted.

This lane deliberately requires the maintainer to say when grilling is finished. Inferring completion
from prose or punctuation would risk promoting a ticket with unresolved decisions. Do not run more
than one panel instance for the same clone: the saved OpenCode session and checkout are single-writer
state.

## Start the runner and panel

From a clean DotRelay clone, start the panel in one terminal:

```sh
bun run issues:panel
```

Start the runner in another terminal or a persistent terminal session:

```sh
bun run issues:run
```

The panel listens on `127.0.0.1:4173` by default. These environment variables override its local
configuration:

- `ISSUES_PANEL_HOST`: listening address. Keep the default when using Tailscale Serve.
- `ISSUES_PANEL_PORT`: listening port. Defaults to `4173`.
- `ISSUES_PANEL_RUNS_DIR`: alternate directory containing `status.json`, `state.json`, and controller
  logs.

## Publish it privately with Tailscale

On the machine running the panel:

```sh
sudo tailscale serve --bg --https=8443 localhost:4173
```

Port `8443` keeps the panel separate from anything already served on the machine's default HTTPS
port. Tailscale prints the private HTTPS URL, which normally uses the machine's MagicDNS name:

```text
https://<machine-name>.<tailnet-name>.ts.net:8443
```

Only devices allowed by the tailnet policy can reach a Tailscale Serve endpoint. Do not use
Tailscale Funnel for this panel: Funnel would publish runner output to the public internet.

Check the active proxy configuration with:

```sh
tailscale serve status
```

## Data exposure

Controller transcripts include OpenCode responses, tool titles, command output, issue titles, and
GitHub URLs. They should still be treated as private operational data even though the panel does
not expose raw per-session NDJSON. Keep the panel bound to localhost and rely on Tailscale Serve for
remote access.

Anyone who can reach the panel can start or stop the issue runner, so tailnet access to this endpoint
is operational access. The same user can answer grills and promote a fully specified ticket into the
unattended implementation queue. The control API accepts only POST requests carrying a panel-only header
and rejects cross-site browser requests. It exposes no arbitrary command, retry, merge, or shell endpoint.
A stop sends `SIGTERM` to the saved controller process so it can stop its worker and preserve its
journal for the next start.
