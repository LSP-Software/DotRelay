#!/usr/bin/env bash

set -Eeuo pipefail

# Run from a clean clone of LSP-Software/DotRelay.
# Required: bash, git, gh, jq, opencode.
# Optional overrides:
#   BASE_BRANCH=main
#   MERGE_METHOD=squash          # squash, merge, or rebase
#   OPENCODE_MODEL=provider/model
#   OPENCODE_AGENT=agent-name
#   CHECK_DISCOVERY_TIMEOUT=180
#   MERGE_TIMEOUT=3600
#   ALLOW_NO_CHECKS=0            # set to 1 only if this repo intentionally has no CI

BASE_BRANCH="${BASE_BRANCH:-main}"
MERGE_METHOD="${MERGE_METHOD:-squash}"
CHECK_DISCOVERY_TIMEOUT="${CHECK_DISCOVERY_TIMEOUT:-180}"
MERGE_TIMEOUT="${MERGE_TIMEOUT:-3600}"
ALLOW_NO_CHECKS="${ALLOW_NO_CHECKS:-0}"

ACTIVE_ISSUE=""
ACTIVE_BRANCH=""
ACTIVE_LOG=""

die() {
  printf 'ERROR: %s\n' "$*" >&2
  if [[ -n "$ACTIVE_ISSUE" ]]; then
    printf 'Issue #%s remains assigned so another run will not pick it up.\n' "$ACTIVE_ISSUE" >&2
    printf 'Resume or inspect branch %s and log %s.\n' "${ACTIVE_BRANCH:-not-created}" "${ACTIVE_LOG:-not-created}" >&2
    printf 'To release it manually: gh issue edit %s --remove-assignee @me\n' "$ACTIVE_ISSUE" >&2
  fi
  exit 1
}

for command_name in git gh jq opencode; do
  command -v "$command_name" >/dev/null 2>&1 || die "Missing required command: $command_name"
done

gh auth status >/dev/null 2>&1 || die "GitHub CLI is not authenticated. Run: gh auth login"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Run this inside a Git clone."
cd "$REPO_ROOT"

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
[[ "$REPO" == "LSP-Software/DotRelay" ]] || die "Expected LSP-Software/DotRelay, found $REPO"

case "$MERGE_METHOD" in
  squash|merge|rebase) ;;
  *) die "MERGE_METHOD must be squash, merge, or rebase." ;;
esac

[[ "$CHECK_DISCOVERY_TIMEOUT" =~ ^[0-9]+$ ]] || die "CHECK_DISCOVERY_TIMEOUT must be an integer."
[[ "$MERGE_TIMEOUT" =~ ^[0-9]+$ ]] || die "MERGE_TIMEOUT must be an integer."
[[ "$ALLOW_NO_CHECKS" == "0" || "$ALLOW_NO_CHECKS" == "1" ]] || die "ALLOW_NO_CHECKS must be 0 or 1."

if [[ -n "$(git status --porcelain=v1 --untracked-files=normal)" ]]; then
  die "The worktree is not clean. Commit, stash, or remove those changes first."
fi

RUN_LOG_DIR="$(git rev-parse --git-path opencode-runs)"
mkdir -p "$RUN_LOG_DIR"

sync_main() {
  git fetch --prune origin "$BASE_BRANCH"
  git switch "$BASE_BRANCH"
  git merge --ff-only "origin/$BASE_BRANCH"

  local_sha="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse "origin/$BASE_BRANCH")"
  [[ "$local_sha" == "$remote_sha" ]] || die "Local $BASE_BRANCH is not identical to origin/$BASE_BRANCH."
  [[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]] || die "The worktree became dirty while syncing $BASE_BRANCH."
}

next_issue() {
  gh api --paginate \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "repos/$REPO/issues?state=open&per_page=100" |
    jq -sc '
      add
      | map(
          select(has("pull_request") | not)
          | select(any(.labels[]?; .name == "ready-for-agent"))
          | select((.assignees | length) == 0)
          | select(.issue_dependencies_summary != null)
          | select(.issue_dependencies_summary.blocked_by == 0)
          | . + {
              priority: (
                try ((.body // "") | capture("Priority:[[:space:]]*P(?<n>[0-9]+)"; "i").n | tonumber)
                catch null
              )
            }
          | select(.priority != null)
        )
      | sort_by(.priority, .number)
      | .[0] // empty
    '
}

wait_for_checks() {
  pr_url="$1"
  deadline=$((SECONDS + CHECK_DISCOVERY_TIMEOUT))

  while true; do
    set +e
    check_probe="$(gh pr checks "$pr_url" 2>&1)"
    set -e

    if ! grep -qi 'no checks reported' <<<"$check_probe"; then
      break
    fi

    if (( SECONDS >= deadline )); then
      if [[ "$ALLOW_NO_CHECKS" == "1" ]]; then
        printf 'No CI checks appeared; continuing because ALLOW_NO_CHECKS=1.\n'
        return 0
      fi
      printf '%s\n' "$check_probe" >&2
      die "No CI checks appeared within ${CHECK_DISCOVERY_TIMEOUT}s."
    fi

    sleep 5
  done

  # A pending check commonly gives a nonzero result in the probe above.
  # This command waits until every reported check finishes and fails on a bad check.
  gh pr checks "$pr_url" --watch --fail-fast || die "CI failed for $pr_url"
}

while true; do
  ACTIVE_ISSUE=""
  ACTIVE_BRANCH=""
  ACTIVE_LOG=""

  sync_main

  ISSUE_JSON="$(next_issue)"
  if [[ -z "$ISSUE_JSON" ]]; then
    printf 'No open, unassigned, unblocked, explicitly prioritized ready-for-agent issues remain.\n'
    exit 0
  fi

  ACTIVE_ISSUE="$(jq -r .number <<<"$ISSUE_JSON")"
  ISSUE_TITLE="$(jq -r .title <<<"$ISSUE_JSON")"
  ISSUE_URL="$(jq -r .html_url <<<"$ISSUE_JSON")"
  ISSUE_PRIORITY="$(jq -r .priority <<<"$ISSUE_JSON")"
  ACTIVE_BRANCH="agent/issue-$ACTIVE_ISSUE"
  ACTIVE_LOG="$RUN_LOG_DIR/issue-$ACTIVE_ISSUE.ndjson"

  printf '\nSelected P%s issue #%s: %s\n%s\n' \
    "$ISSUE_PRIORITY" "$ACTIVE_ISSUE" "$ISSUE_TITLE" "$ISSUE_URL"

  # Re-read immediately before claiming. This narrows the race with another worker.
  STILL_FREE="$(
    gh api -H 'Accept: application/vnd.github+json' "repos/$REPO/issues/$ACTIVE_ISSUE" |
      jq -r '
        .state == "open"
        and any(.labels[]?; .name == "ready-for-agent")
        and ((.assignees | length) == 0)
        and (.issue_dependencies_summary != null)
        and (.issue_dependencies_summary.blocked_by == 0)
      '
  )"
  [[ "$STILL_FREE" == "true" ]] || die "Issue #$ACTIVE_ISSUE was claimed or blocked by another worker."

  gh issue edit "$ACTIVE_ISSUE" --add-assignee @me >/dev/null

  if git show-ref --verify --quiet "refs/heads/$ACTIVE_BRANCH"; then
    die "Local branch $ACTIVE_BRANCH already exists."
  fi
  if git ls-remote --exit-code --heads origin "$ACTIVE_BRANCH" >/dev/null 2>&1; then
    die "Remote branch $ACTIVE_BRANCH already exists."
  fi

  git switch -c "$ACTIVE_BRANCH"
  BASE_SHA="$(git rev-parse "origin/$BASE_BRANCH")"

  printf -v PROMPT '%s\n' \
    "Use the implement skill to implement exactly this ticket: $ISSUE_URL" \
    "Expected title: $ISSUE_TITLE" \
    "Resolve the full URL and confirm the title before editing. Read the issue body, every comment, AGENTS.md, and the linked repository docs. Work only on this issue against the current branch, which starts at the latest origin/$BASE_BRANCH." \
    "Run the tests and checks required by the issue and repository. The implement skill must finish by committing the work. Leave a clean worktree." \
    "Do not assign or unassign issues. Do not close the issue. Do not push, create a PR, or merge. The controller handles those steps." \
    "Do not ask questions in this unattended run. If the issue is already satisfied or a material decision is missing, make no speculative change and explain the blocker in your final response."

  OPENCODE_ARGS=(
    run
    --dir "$REPO_ROOT"
    --auto
    --format json
    --title "dotrelay-issue-$ACTIVE_ISSUE"
  )
  if [[ -n "${OPENCODE_MODEL:-}" ]]; then
    OPENCODE_ARGS+=(--model "$OPENCODE_MODEL")
  fi
  if [[ -n "${OPENCODE_AGENT:-}" ]]; then
    OPENCODE_ARGS+=(--agent "$OPENCODE_AGENT")
  fi

  set +e
  opencode "${OPENCODE_ARGS[@]}" "$PROMPT" | tee "$ACTIVE_LOG"
  OPENCODE_STATUS=${PIPESTATUS[0]}
  set -e

  [[ "$OPENCODE_STATUS" -eq 0 ]] || die "OpenCode exited with status $OPENCODE_STATUS."
  if jq -e 'select(.type == "error")' "$ACTIVE_LOG" >/dev/null 2>&1; then
    die "OpenCode emitted a session error."
  fi

  TOOL_ERROR_COUNT="$(jq -s '[.[] | select(.type == "tool_use" and .part.state.status == "error")] | length' "$ACTIVE_LOG")"
  if [[ "$TOOL_ERROR_COUNT" -gt 0 ]]; then
    printf 'OpenCode reported %s failed tool call(s); relying on the final clean-tree and CI gates.\n' "$TOOL_ERROR_COUNT" >&2
  fi

  [[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]] || die "OpenCode left uncommitted changes."
  HEAD_SHA="$(git rev-parse HEAD)"
  [[ "$HEAD_SHA" != "$BASE_SHA" ]] || die "OpenCode produced no commit."
  git merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA" || die "The result is not based on the selected main commit."

  git push --set-upstream origin "$ACTIVE_BRANCH"

  EXISTING_PR="$(gh pr list --state open --head "$ACTIVE_BRANCH" --json url --jq '.[0].url // empty')"
  if [[ -n "$EXISTING_PR" ]]; then
    PR_URL="$EXISTING_PR"
  else
    printf -v PR_BODY 'Closes #%s\n\nImplemented from the agent-ready ticket in a fresh OpenCode session.' "$ACTIVE_ISSUE"
    PR_URL="$(
      gh pr create \
        --base "$BASE_BRANCH" \
        --head "$ACTIVE_BRANCH" \
        --title "$ISSUE_TITLE" \
        --body "$PR_BODY"
    )"
  fi

  printf 'Opened %s\n' "$PR_URL"

  PR_META="$(gh pr view "$PR_URL" --json baseRefName,headRefName,isDraft,closingIssuesReferences)"
  VALID_PR="$(
    jq -r \
      --arg base "$BASE_BRANCH" \
      --arg head "$ACTIVE_BRANCH" \
      --argjson issue "$ACTIVE_ISSUE" \
      '.baseRefName == $base
       and .headRefName == $head
       and (.isDraft | not)
       and any(.closingIssuesReferences[]?; .number == $issue)' <<<"$PR_META"
  )"
  [[ "$VALID_PR" == "true" ]] || die "The PR does not have the expected base, head, or closing issue reference."

  wait_for_checks "$PR_URL"

  PR_HEAD_SHA="$(gh pr view "$PR_URL" --json headRefOid --jq .headRefOid)"
  [[ "$PR_HEAD_SHA" == "$HEAD_SHA" ]] || die "The PR head changed after the OpenCode run."

  git switch "$BASE_BRANCH"
  gh pr merge "$PR_URL" \
    "--$MERGE_METHOD" \
    --delete-branch \
    --match-head-commit "$HEAD_SHA" || die "GitHub did not merge $PR_URL"

  MERGE_DEADLINE=$((SECONDS + MERGE_TIMEOUT))
  while true; do
    PR_STATE="$(gh pr view "$PR_URL" --json state --jq .state)"
    [[ "$PR_STATE" == "MERGED" ]] && break
    [[ "$PR_STATE" == "OPEN" ]] || die "PR state is $PR_STATE, not MERGED."
    (( SECONDS < MERGE_DEADLINE )) || die "PR did not merge within ${MERGE_TIMEOUT}s."
    sleep 10
  done

  ISSUE_STATE="$(gh issue view "$ACTIVE_ISSUE" --json state --jq .state)"
  [[ "$ISSUE_STATE" == "CLOSED" ]] || die "Issue #$ACTIVE_ISSUE did not close after merge."

  printf 'Merged issue #%s. Starting the next issue in a fresh OpenCode session.\n' "$ACTIVE_ISSUE"
done

