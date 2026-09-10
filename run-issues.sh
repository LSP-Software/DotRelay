#!/usr/bin/env bash

set -Eeuo pipefail

# Run from a clean clone of LSP-Software/DotRelay.
# Required: bash, git, gh, jq, opencode.
# Optional overrides:
#   BASE_BRANCH=main
#   MERGE_METHOD=squash          # squash, merge, or rebase
#   OPENCODE_MODEL=provider/model
#   OPENCODE_AGENT=agent-name
#   LOG_VIEW=pretty               # pretty or json
#   CHECK_DISCOVERY_TIMEOUT=180
#   MERGE_TIMEOUT=3600
#   MAX_REPAIR_ATTEMPTS=3
#   ALLOW_NO_CHECKS=0            # set to 1 only if this repo intentionally has no CI

BASE_BRANCH="${BASE_BRANCH:-main}"
MERGE_METHOD="${MERGE_METHOD:-squash}"
LOG_VIEW="${LOG_VIEW:-pretty}"
CHECK_DISCOVERY_TIMEOUT="${CHECK_DISCOVERY_TIMEOUT:-180}"
MERGE_TIMEOUT="${MERGE_TIMEOUT:-3600}"
MAX_REPAIR_ATTEMPTS="${MAX_REPAIR_ATTEMPTS:-3}"
ALLOW_NO_CHECKS="${ALLOW_NO_CHECKS:-0}"

ACTIVE_ISSUE=""
ACTIVE_BRANCH=""
ACTIVE_LOG=""
CONTROLLER_LOG=""

die() {
  printf 'ERROR: %s\n' "$*" >&2
  if [[ -n "$ACTIVE_ISSUE" ]]; then
    printf 'Issue #%s remains assigned so another run will not pick it up.\n' "$ACTIVE_ISSUE" >&2
    printf 'Resume or inspect branch %s and log %s.\n' "${ACTIVE_BRANCH:-not-created}" "${ACTIVE_LOG:-not-created}" >&2
    printf 'To release it manually: gh issue edit %s --remove-assignee @me\n' "$ACTIVE_ISSUE" >&2
  fi
  if [[ -n "$CONTROLLER_LOG" ]]; then
    printf 'Full run transcript: %s\n' "$CONTROLLER_LOG" >&2
  fi
  exit 1
}

for command_name in git gh jq opencode; do
for command_name in git gh jq opencode tee; do
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
[[ "$MAX_REPAIR_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "MAX_REPAIR_ATTEMPTS must be a positive integer."
[[ "$ALLOW_NO_CHECKS" == "0" || "$ALLOW_NO_CHECKS" == "1" ]] || die "ALLOW_NO_CHECKS must be 0 or 1."
[[ "$LOG_VIEW" == "pretty" || "$LOG_VIEW" == "json" ]] || die "LOG_VIEW must be pretty or json."

if [[ -n "$(git status --porcelain=v1 --untracked-files=normal)" ]]; then
  die "The worktree is not clean. Commit, stash, or remove those changes first."
fi

RUN_LOG_DIR="$(git rev-parse --git-path opencode-runs)"
mkdir -p "$RUN_LOG_DIR"

RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')-$$"
CONTROLLER_LOG="$RUN_LOG_DIR/run-$RUN_ID.log"

# Keep one readable transcript for the entire loop. Individual OpenCode sessions
# also retain their complete NDJSON event streams as issue-N.ndjson files.
exec > >(tee -a "$CONTROLLER_LOG") 2>&1

printf 'DotRelay issue run started at %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf 'Full run transcript: %s\n' "$CONTROLLER_LOG"
printf 'Raw OpenCode event logs: %s/issue-N.ndjson\n\n' "$RUN_LOG_DIR"

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

format_opencode_events() {
  jq --unbuffered -r '
    def compact:
      tostring
      | gsub("[[:space:]]+"; " ")
      | if length > 180 then .[0:177] + "..." else . end;

    def tool_title:
      .part.state.title
      // (
        if .part.tool == "bash" and .part.state.input.command? then
          "bash: " + (.part.state.input.command | split("\n")[0])
        else
          .part.tool // "unknown tool"
        end
      );

    if .type == "text" then
      "\n" + (.part.text // "")
    elif .type == "tool_use" and .part.state.status == "running" then
      "[tool] " + (tool_title | compact)
    elif .type == "tool_use" and .part.state.status == "completed" then
      "[done] " + (tool_title | compact)
    elif .type == "tool_use" and .part.state.status == "error" then
      "[tool failed] " + (tool_title | compact) +
      (if .part.state.error? then "\n  " + (.part.state.error | compact) else "" end)
    elif .type == "error" then
      "[session error] " + (
        .error.message
        // .error.data.message
        // .part.message
        // "Unknown OpenCode error"
        | compact
      )
    else
      empty
    end
  '
}

run_opencode_session() {
  session_title="$1"
  session_prompt="$2"
  session_log="$3"
  ACTIVE_LOG="$session_log"

  OPENCODE_ARGS=(
    run
    --dir "$REPO_ROOT"
    --auto
    --format json
    --title "$session_title"
  )
  if [[ -n "${OPENCODE_MODEL:-}" ]]; then
    OPENCODE_ARGS+=(--model "$OPENCODE_MODEL")
  fi
  if [[ -n "${OPENCODE_AGENT:-}" ]]; then
    OPENCODE_ARGS+=(--agent "$OPENCODE_AGENT")
  fi

  printf '\nOpenCode live output. Raw event log: %s\n\n' "$ACTIVE_LOG"
  set +e
  if [[ "$LOG_VIEW" == "pretty" ]]; then
    opencode "${OPENCODE_ARGS[@]}" "$session_prompt" | tee "$ACTIVE_LOG" | format_opencode_events
    PIPELINE_STATUS=("${PIPESTATUS[@]}")
    OPENCODE_STATUS=${PIPELINE_STATUS[0]}
    TEE_STATUS=${PIPELINE_STATUS[1]}
    FORMATTER_STATUS=${PIPELINE_STATUS[2]}
  else
    opencode "${OPENCODE_ARGS[@]}" "$session_prompt" | tee "$ACTIVE_LOG"
    PIPELINE_STATUS=("${PIPESTATUS[@]}")
    OPENCODE_STATUS=${PIPELINE_STATUS[0]}
    TEE_STATUS=${PIPELINE_STATUS[1]}
    FORMATTER_STATUS=0
  fi
  set -e

  [[ "$OPENCODE_STATUS" -eq 0 ]] || die "OpenCode exited with status $OPENCODE_STATUS."
  [[ "$TEE_STATUS" -eq 0 ]] || die "Could not save the OpenCode event log."
  [[ "$FORMATTER_STATUS" -eq 0 ]] || die "Could not format the OpenCode event stream."
  if jq -e 'select(.type == "error")' "$ACTIVE_LOG" >/dev/null 2>&1; then
    die "OpenCode emitted a session error."
  fi

  TOOL_ERROR_COUNT="$(jq -s '[.[] | select(.type == "tool_use" and .part.state.status == "error")] | length' "$ACTIVE_LOG")"
  if [[ "$TOOL_ERROR_COUNT" -gt 0 ]]; then
    printf 'OpenCode reported %s failed tool call(s); relying on the final clean-tree and CI gates.\n' "$TOOL_ERROR_COUNT" >&2
  fi
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
  if ! gh pr checks "$pr_url" --watch --fail-fast; then
    return 1
  fi

  REVIEW_DECISION="$(gh pr view "$pr_url" --json reviewDecision --jq '.reviewDecision // ""')"
  if [[ "$REVIEW_DECISION" == "CHANGES_REQUESTED" ]]; then
    printf 'A PR reviewer requested changes.\n' >&2
    return 1
  fi

  return 0
}

validate_pr() {
  pr_url="$1"
  issue_number="$2"
  expected_branch="$3"
  closing_line="Closes #$issue_number"

  # GitHub can take a few seconds to populate closingIssuesReferences after PR
  # creation. Validate the exact closing line immediately, then prove that the
  # issue closed after merge in finish_pr.
  PR_META="$(gh pr view "$pr_url" --json baseRefName,headRefName,isDraft,body)"
  VALID_PR="$(
    jq -r \
      --arg base "$BASE_BRANCH" \
      --arg head "$expected_branch" \
      --arg closing "$closing_line" \
      '.baseRefName == $base
       and .headRefName == $head
       and (.isDraft | not)
       and (((.body // "") | split("\n") | index($closing)) != null)' <<<"$PR_META"
  )"
  [[ "$VALID_PR" == "true" ]] || die "The PR does not have the expected base, head, or exact closing line."
}

repair_pr() {
  pr_url="$1"
  issue_number="$2"
  expected_branch="$3"
  expected_head_sha="$4"
  repair_attempt="$5"

  printf '\nPR gates failed. Starting repair attempt %s of %s.\n' "$repair_attempt" "$MAX_REPAIR_ATTEMPTS"

  [[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]] || die "The worktree is dirty before PR repair."
  git fetch origin "$expected_branch"

  if git show-ref --verify --quiet "refs/heads/$expected_branch"; then
    git switch "$expected_branch"
  else
    git switch --track -c "$expected_branch" "origin/$expected_branch"
  fi
  git merge --ff-only "origin/$expected_branch"

  REPAIR_BASE_SHA="$(git rev-parse HEAD)"
  [[ "$REPAIR_BASE_SHA" == "$expected_head_sha" ]] || die "The local repair branch does not match the PR head."

  ISSUE_URL="https://github.com/$REPO/issues/$issue_number"
  REPAIR_LOG="$RUN_LOG_DIR/issue-$issue_number-repair-$repair_attempt.ndjson"
  printf -v REPAIR_PROMPT '%s\n' \
    "Use the implement skill to repair this existing pull request: $pr_url" \
    "The original ticket is: $ISSUE_URL" \
    "This is repair attempt $repair_attempt of $MAX_REPAIR_ATTEMPTS. Read every failed or cancelled GitHub Actions log, all PR review summaries, and every unresolved inline review thread. Use the GitHub CLI to fetch details that are not in the page summary." \
    "Fix every actionable failure within the ticket's scope. Address root causes; do not weaken, delete, or skip tests and do not dismiss valid review feedback. Treat infrastructure-only failures separately and rerun or explain them without changing unrelated code." \
    "Run the relevant focused tests and repository checks. Use the code-review skill before finishing. Commit the repair and leave a clean worktree." \
    "Do not close or unassign the issue. Do not create another PR or merge. Do not ask questions in this unattended run."

  run_opencode_session "dotrelay-issue-$issue_number-repair-$repair_attempt" "$REPAIR_PROMPT" "$REPAIR_LOG"

  [[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]] || die "OpenCode left uncommitted repair changes."
  REPAIRED_HEAD_SHA="$(git rev-parse HEAD)"
  [[ "$REPAIRED_HEAD_SHA" != "$REPAIR_BASE_SHA" ]] || die "The repair session produced no commit."
  git merge-base --is-ancestor "$REPAIR_BASE_SHA" "$REPAIRED_HEAD_SHA" || die "The repair commit does not descend from the PR head."

  git push origin "$expected_branch"

  PUSH_DEADLINE=$((SECONDS + 60))
  while true; do
    REMOTE_PR_HEAD="$(gh pr view "$pr_url" --json headRefOid --jq .headRefOid)"
    [[ "$REMOTE_PR_HEAD" == "$REPAIRED_HEAD_SHA" ]] && break
    (( SECONDS < PUSH_DEADLINE )) || die "GitHub did not update the PR head after the repair push."
    sleep 2
  done

  printf 'Pushed repair commit %s to %s.\n' "$REPAIRED_HEAD_SHA" "$pr_url"
}

finish_pr() {
  pr_url="$1"
  issue_number="$2"
  expected_branch="$3"
  expected_head_sha="$4"

  validate_pr "$pr_url" "$issue_number" "$expected_branch"
  repair_attempt=0
  while ! wait_for_checks "$pr_url"; do
    repair_attempt=$((repair_attempt + 1))
    (( repair_attempt <= MAX_REPAIR_ATTEMPTS )) || die "PR gates still fail after $MAX_REPAIR_ATTEMPTS repair attempts."

    repair_pr "$pr_url" "$issue_number" "$expected_branch" "$expected_head_sha" "$repair_attempt"
    expected_head_sha="$REPAIRED_HEAD_SHA"
    validate_pr "$pr_url" "$issue_number" "$expected_branch"
  done

  PR_HEAD_SHA="$(gh pr view "$pr_url" --json headRefOid --jq .headRefOid)"
  [[ "$PR_HEAD_SHA" == "$expected_head_sha" ]] || die "The PR head changed after the OpenCode run."

  git switch "$BASE_BRANCH"
  gh pr merge "$pr_url" \
    "--$MERGE_METHOD" \
    --delete-branch \
    --match-head-commit "$expected_head_sha" || die "GitHub did not merge $pr_url"

  MERGE_DEADLINE=$((SECONDS + MERGE_TIMEOUT))
  while true; do
    PR_STATE="$(gh pr view "$pr_url" --json state --jq .state)"
    [[ "$PR_STATE" == "MERGED" ]] && break
    [[ "$PR_STATE" == "OPEN" ]] || die "PR state is $PR_STATE, not MERGED."
    (( SECONDS < MERGE_DEADLINE )) || die "PR did not merge within ${MERGE_TIMEOUT}s."
    sleep 10
  done

  ISSUE_STATE="$(gh issue view "$issue_number" --json state --jq .state)"
  [[ "$ISSUE_STATE" == "CLOSED" ]] || die "Issue #$issue_number did not close after merge."

  printf 'Merged issue #%s. Starting the next issue in a fresh OpenCode session.\n' "$issue_number"
}

while true; do
  ACTIVE_ISSUE=""
  ACTIVE_BRANCH=""
  ACTIVE_LOG=""

  sync_main

  # Recover cleanly from a stopped controller after it opened the PR. The
  # agent/issue-N branch namespace belongs to this script.
  RESUME_JSON="$(
    gh pr list \
      --state open \
      --base "$BASE_BRANCH" \
      --author @me \
      --limit 100 \
      --json number,url,headRefName,headRefOid \
      --jq '[.[] | select(.headRefName | test("^agent/issue-[0-9]+$"))] | sort_by(.number) | .[0] // empty'
  )"
  if [[ -n "$RESUME_JSON" ]]; then
    PR_URL="$(jq -r .url <<<"$RESUME_JSON")"
    ACTIVE_BRANCH="$(jq -r .headRefName <<<"$RESUME_JSON")"
    ACTIVE_ISSUE="${ACTIVE_BRANCH#agent/issue-}"
    HEAD_SHA="$(jq -r .headRefOid <<<"$RESUME_JSON")"
    ACTIVE_LOG="$RUN_LOG_DIR/issue-$ACTIVE_ISSUE.ndjson"

    printf '\nResuming open PR for issue #%s: %s\n' "$ACTIVE_ISSUE" "$PR_URL"
    finish_pr "$PR_URL" "$ACTIVE_ISSUE" "$ACTIVE_BRANCH" "$HEAD_SHA"
    continue
  fi

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
  run_opencode_session "dotrelay-issue-$ACTIVE_ISSUE" "$PROMPT" "$ACTIVE_LOG"

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
  finish_pr "$PR_URL" "$ACTIVE_ISSUE" "$ACTIVE_BRANCH" "$HEAD_SHA"
done