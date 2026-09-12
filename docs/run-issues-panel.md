# Issue runner panel

The issue runner panel is a read-only local dashboard for `run-issues.sh`. It shows the current
runner stage, active issue and pull request, process health, elapsed time, recent runs, and a live
controller transcript.

The controller writes an atomic status document and one combined transcript per invocation in
`.git/issue-runner/`. The panel reads that controller directory and its queue journal directly; it
never executes shell commands or changes runner state. Per-issue checkpoints and private checkouts
remain under `.git/issue-runner/issue-N/` and are not exposed by the panel.

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
https://llmrex.tail0de2f.ts.net:8443
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

The panel has no start, stop, retry, merge, or shell endpoints. Runner control remains in the
terminal so opening the dashboard cannot mutate the repository or GitHub state.
