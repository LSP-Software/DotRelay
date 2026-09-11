#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${RUN_ISSUES_WORKER:-0}" != "1" ]]; then
  command -v bun >/dev/null 2>&1 || { printf 'Bun is required.\n' >&2; exit 1; }
  exec bun "$SCRIPT_DIR/scripts/run-issues-controller.ts" "$@"
fi

# Each worker runs in a persistent, private clone owned by the controller.
# Time limits include child processes, including tools started by OpenCode.
git() { bun "$SCRIPT_DIR/scripts/run-issues-process.ts" "${COMMAND_TIMEOUT:-120}" git "$@"; }
gh() { bun "$SCRIPT_DIR/scripts/run-issues-process.ts" "${COMMAND_TIMEOUT:-120}" gh "$@"; }
opencode() { bun "$SCRIPT_DIR/scripts/run-issues-process.ts" "${SESSION_TIMEOUT:-3600}" opencode "$@"; }

# Controller-managed worker for LSP-Software/DotRelay. See docs/run-issues.md.
# Required: bun, bash, git, gh, jq, opencode, ps.
# Optional overrides:
#   BASE_BRANCH=main
#   MERGE_METHOD=squash          # squash, merge, or rebase
#   OPENCODE_MODEL=provider/model
#   OPENCODE_AGENT=agent-name
#   LOG_VIEW=pretty               # pretty or json
#   CHECK_DISCOVERY_TIMEOUT=600
#   CHECK_TIMEOUT=7200
#   CHECK_POLL_INTERVAL=10
#   CHECK_SETTLE_SECONDS=30
#   ADVISORY_CHECK_REGEX='^CodeRabbit$'
#   MERGE_TIMEOUT=3600
#   ISSUE_CLOSE_TIMEOUT=300
#   MAX_REPAIR_ATTEMPTS=5
#   MAX_SESSION_ATTEMPTS=3
#   SESSION_RETRY_DELAY=10
#   GH_RETRY_ATTEMPTS=6
#   GH_RETRY_DELAY=2
#   CI_RERUN_START_TIMEOUT=180
#   ALLOW_NO_CHECKS=0            # set to 1 only if this repo intentionally has no CI

BASE_BRANCH="${BASE_BRANCH:-main}"
MERGE_METHOD="${MERGE_METHOD:-squash}"
LOG_VIEW="${LOG_VIEW:-pretty}"
CHECK_DISCOVERY_TIMEOUT="${CHECK_DISCOVERY_TIMEOUT:-600}"
CHECK_TIMEOUT="${CHECK_TIMEOUT:-7200}"
CHECK_POLL_INTERVAL="${CHECK_POLL_INTERVAL:-10}"
CHECK_SETTLE_SECONDS="${CHECK_SETTLE_SECONDS:-30}"
ADVISORY_CHECK_REGEX="${ADVISORY_CHECK_REGEX:-^CodeRabbit$}"
MERGE_TIMEOUT="${MERGE_TIMEOUT:-3600}"
ISSUE_CLOSE_TIMEOUT="${ISSUE_CLOSE_TIMEOUT:-300}"
MAX_REPAIR_ATTEMPTS="${MAX_REPAIR_ATTEMPTS:-5}"
MAX_SESSION_ATTEMPTS="${MAX_SESSION_ATTEMPTS:-3}"
SESSION_RETRY_DELAY="${SESSION_RETRY_DELAY:-10}"
GH_RETRY_ATTEMPTS="${GH_RETRY_ATTEMPTS:-6}"
GH_RETRY_DELAY="${GH_RETRY_DELAY:-2}"
CI_RERUN_START_TIMEOUT="${CI_RERUN_START_TIMEOUT:-180}"
ALLOW_NO_CHECKS="${ALLOW_NO_CHECKS:-0}"

ACTIVE_ISSUE=""
ACTIVE_BRANCH=""
ACTIVE_LOG=""
CONTROLLER_LOG=""
CONTROLLER_LOCK_DIR=""
LAST_GATE_REASON=""
ACKNOWLEDGED_CODERABBIT_SHA=""

save_checkpoint() {
  local temporary="$WORKER_STATE.tmp"
  jq -n --arg base "${BASE_SHA:-}" --argjson repairs "${REPAIR_COUNT:-0}" \
    --arg advisory "$ACKNOWLEDGED_CODERABBIT_SHA" \
    '{base: $base, repairs: $repairs, advisory: $advisory}' >"$temporary"
  mv "$temporary" "$WORKER_STATE"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  if [[ -n "$ACTIVE_ISSUE" ]]; then
    printf 'Issue #%s is preserved in the controller journal for retry or inspection.\n' "$ACTIVE_ISSUE" >&2
    printf 'Resume or inspect branch %s and log %s.\n' "${ACTIVE_BRANCH:-not-created}" "${ACTIVE_LOG:-not-created}" >&2
  fi
  if [[ -n "$CONTROLLER_LOG" ]]; then
    printf 'Full run transcript: %s\n' "$CONTROLLER_LOG" >&2
  fi
  if [[ -f "${RUN_UNSAFE_MARKER:-/nonexistent}" ]]; then exit 70; fi
  # The process wrapper leaves a marker for network failures and timeouts. Do not
  # spend the issue's implementation budget on a service outage.
  if [[ -f "${RUN_INFRA_MARKER:-/nonexistent}" ]]; then exit 75; fi
  exit 1
}

capture_once() {
  local destination="$1"
  local captured_output=""
  local captured_error=""
  local captured_status=0
  local error_file=""
  shift

  error_file="$(mktemp "${TMPDIR:-/tmp}/dotrelay-controller.XXXXXX")" \
    || return 1

  set +e
  captured_output="$("$@" 2>"$error_file")"
  captured_status=$?
  set -e
  captured_error="$(<"$error_file")"
  rm -f "$error_file"

  if [[ "$captured_status" -eq 0 ]]; then
    [[ -z "$captured_error" ]] || printf '%s\n' "$captured_error" >&2
  elif [[ -n "$captured_error" ]]; then
    if [[ -n "$captured_output" ]]; then
      captured_output+=$'\n'
    fi
    captured_output+="$captured_error"
  fi

  printf -v "$destination" '%s' "$captured_output"
  return "$captured_status"
}

capture_with_retry() {
  local destination="$1"
  local attempt=1
  local delay="$GH_RETRY_DELAY"
  local attempt_output=""
  shift

  while true; do
    if capture_once attempt_output "$@"; then
      printf -v "$destination" '%s' "$attempt_output"
      return 0
    fi

    if (( attempt >= GH_RETRY_ATTEMPTS )); then
      printf '%s\n' "$attempt_output" >&2
      return 1
    fi

    printf 'Read command failed, retrying in %ss, attempt %s of %s.\n' \
      "$delay" "$attempt" "$GH_RETRY_ATTEMPTS" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    (( delay < 30 )) && delay=$((delay * 2))
    (( delay > 30 )) && delay=30
  done
}

retry_command() {
  local attempt=1
  local delay="$GH_RETRY_DELAY"
  local command_status=0

  while true; do
    if "$@"; then
      return 0
    else
      command_status=$?
    fi

    if (( attempt >= GH_RETRY_ATTEMPTS )); then
      return "$command_status"
    fi

    printf 'Command failed, retrying in %ss, attempt %s of %s: %s\n' \
      "$delay" "$attempt" "$GH_RETRY_ATTEMPTS" "$1" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    (( delay < 30 )) && delay=$((delay * 2))
    (( delay > 30 )) && delay=30
  done
}

release_controller_lock() {
  local lock_pid=""
  [[ -n "$CONTROLLER_LOCK_DIR" ]] || return 0
  [[ -f "$CONTROLLER_LOCK_DIR/pid" ]] || return 0
  read -r lock_pid <"$CONTROLLER_LOCK_DIR/pid" || return 0
  [[ "$lock_pid" == "$$" ]] || return 0
  rm -f "$CONTROLLER_LOCK_DIR/pid"
  rmdir "$CONTROLLER_LOCK_DIR" 2>/dev/null || true
}

case "$MERGE_METHOD" in
  squash|merge|rebase) ;;
  *) die "MERGE_METHOD must be squash, merge, or rebase." ;;
esac

[[ "$CHECK_DISCOVERY_TIMEOUT" =~ ^[0-9]+$ ]] || die "CHECK_DISCOVERY_TIMEOUT must be an integer."
[[ "$CHECK_TIMEOUT" =~ ^[0-9]+$ ]] || die "CHECK_TIMEOUT must be an integer."
[[ "$CHECK_POLL_INTERVAL" =~ ^[0-9]+$ ]] || die "CHECK_POLL_INTERVAL must be an integer."
[[ "$CHECK_SETTLE_SECONDS" =~ ^[0-9]+$ ]] || die "CHECK_SETTLE_SECONDS must be an integer."
[[ -n "$ADVISORY_CHECK_REGEX" ]] || die "ADVISORY_CHECK_REGEX must not be empty."
[[ "$MERGE_TIMEOUT" =~ ^[0-9]+$ ]] || die "MERGE_TIMEOUT must be an integer."
[[ "$ISSUE_CLOSE_TIMEOUT" =~ ^[0-9]+$ ]] || die "ISSUE_CLOSE_TIMEOUT must be an integer."
[[ "$MAX_REPAIR_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "MAX_REPAIR_ATTEMPTS must be a positive integer."
[[ "$MAX_SESSION_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "MAX_SESSION_ATTEMPTS must be a positive integer."
[[ "$SESSION_RETRY_DELAY" =~ ^[0-9]+$ ]] || die "SESSION_RETRY_DELAY must be an integer."
[[ "$GH_RETRY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "GH_RETRY_ATTEMPTS must be a positive integer."
[[ "$GH_RETRY_DELAY" =~ ^[0-9]+$ ]] || die "GH_RETRY_DELAY must be an integer."
[[ "$CI_RERUN_START_TIMEOUT" =~ ^[0-9]+$ ]] || die "CI_RERUN_START_TIMEOUT must be an integer."
[[ "$ALLOW_NO_CHECKS" == "0" || "$ALLOW_NO_CHECKS" == "1" ]] || die "ALLOW_NO_CHECKS must be 0 or 1."
[[ "$LOG_VIEW" == "pretty" || "$LOG_VIEW" == "json" ]] || die "LOG_VIEW must be pretty or json."

for command_name in git gh jq opencode tee mktemp ps; do
  # type -P ignores the timeout wrapper functions declared above.
  type -P "$command_name" >/dev/null 2>&1 || die "Missing required command: $command_name"
done
jq -n --arg regex "$ADVISORY_CHECK_REGEX" 'try ("" | test($regex)) catch halt_error(1)' >/dev/null \
  || die "ADVISORY_CHECK_REGEX is not a valid regular expression."
command git check-ref-format --branch "$BASE_BRANCH" >/dev/null || die "Invalid BASE_BRANCH."
[[ "${RUN_ISSUES_PREFLIGHT:-0}" != "1" ]] || exit 0

retry_command gh auth status >/dev/null 2>&1 || die "GitHub CLI is not authenticated. Run: gh auth login"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Run this inside a Git clone."
cd "$REPO_ROOT"

capture_with_retry REPO gh repo view --json nameWithOwner --jq .nameWithOwner \
  || die "Could not identify the GitHub repository."
[[ "$REPO" == "LSP-Software/DotRelay" ]] || die "Expected LSP-Software/DotRelay, found $REPO"

# Unfinished changes are expected on resume in the controller's private clone.

RUN_LOG_DIR="$(git rev-parse --git-path opencode-runs)"
mkdir -p "$RUN_LOG_DIR"

CONTROLLER_LOCK_DIR="$RUN_LOG_DIR/controller.lock"
if ! mkdir "$CONTROLLER_LOCK_DIR" 2>/dev/null; then
  EXISTING_CONTROLLER_PID=""
  if [[ -f "$CONTROLLER_LOCK_DIR/pid" ]]; then
    read -r EXISTING_CONTROLLER_PID <"$CONTROLLER_LOCK_DIR/pid" || true
  fi
  if [[ "$EXISTING_CONTROLLER_PID" =~ ^[0-9]+$ ]] && kill -0 "$EXISTING_CONTROLLER_PID" 2>/dev/null; then
    die "Another controller is already running with process ID $EXISTING_CONTROLLER_PID."
  fi

  printf 'Removing a stale controller lock.\n' >&2
  rm -f "$CONTROLLER_LOCK_DIR/pid"
  rmdir "$CONTROLLER_LOCK_DIR" 2>/dev/null \
    || die "Could not remove stale controller lock $CONTROLLER_LOCK_DIR."
  mkdir "$CONTROLLER_LOCK_DIR" \
    || die "Could not acquire controller lock $CONTROLLER_LOCK_DIR."
fi
printf '%s\n' "$$" >"$CONTROLLER_LOCK_DIR/pid"
# Revalidate ownership after the pid write: a concurrent controller that
# started from the same stale lock may have removed and re-created the lock
# directory after this process claimed it.
LOCK_OWNER=""
read -r LOCK_OWNER <"$CONTROLLER_LOCK_DIR/pid" || LOCK_OWNER=""
if [[ ! -d "$CONTROLLER_LOCK_DIR" || "$LOCK_OWNER" != "$$" ]]; then
  die "Lost the controller lock $CONTROLLER_LOCK_DIR to a concurrent controller."
fi
trap release_controller_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')-$$"
CONTROLLER_LOG="$RUN_LOG_DIR/run-$RUN_ID.log"

# Keep one readable transcript for the entire loop. Individual OpenCode sessions
# also retain their complete NDJSON event streams as issue-N.ndjson files.
exec > >(tee -a "$CONTROLLER_LOG") 2>&1

printf 'DotRelay issue run started at %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf 'Full run transcript: %s\n' "$CONTROLLER_LOG"
printf 'Raw OpenCode event logs: %s/issue-N.ndjson\n\n' "$RUN_LOG_DIR"

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
  local session_title="$1"
  local session_prompt="$2"
  local session_log="$3"
  local OPENCODE_STATUS=0
  local TEE_STATUS=0
  local FORMATTER_STATUS=0
  local TOOL_ERROR_COUNT=0
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

  if [[ "$OPENCODE_STATUS" -ne 0 ]]; then
    printf 'OpenCode exited with status %s.\n' "$OPENCODE_STATUS" >&2
    return 1
  fi
  if [[ "$TEE_STATUS" -ne 0 ]]; then
    printf 'Could not save the OpenCode event log.\n' >&2
    return 1
  fi
  if [[ "$FORMATTER_STATUS" -ne 0 ]]; then
    printf 'Could not format the OpenCode event stream.\n' >&2
    return 1
  fi
  if [[ ! -s "$ACTIVE_LOG" ]] || ! jq -e . "$ACTIVE_LOG" >/dev/null 2>&1; then
    printf 'OpenCode produced an empty or invalid JSON event log.\n' >&2
    return 1
  fi
  if jq -se 'any(.[]; .type == "error")' "$ACTIVE_LOG" >/dev/null 2>&1; then
    printf 'OpenCode emitted a session error.\n' >&2
    return 1
  fi
  if ! jq -se 'any(.[]; .type == "step_finish" and .part.reason == "stop")' "$ACTIVE_LOG" >/dev/null 2>&1; then
    printf 'OpenCode exited without a completed response.\n' >&2
    return 1
  fi

  TOOL_ERROR_COUNT="$(jq -s '[.[] | select(.type == "tool_use" and .part.state.status == "error")] | length' "$ACTIVE_LOG")"
  if [[ "$TOOL_ERROR_COUNT" -gt 0 ]]; then
    printf 'OpenCode reported %s failed tool call(s); relying on the final clean-tree and CI gates.\n' "$TOOL_ERROR_COUNT" >&2
  fi
  return 0
}

run_opencode_resilient() {
  local session_title="$1"
  local session_prompt="$2"
  local base_log="$3"
  local attempt=1
  local attempt_log=""
  local attempt_prompt=""

  while (( attempt <= MAX_SESSION_ATTEMPTS )); do
    attempt_log="$base_log"
    attempt_prompt="$session_prompt"
    if [[ "$attempt" -gt 1 ]]; then
      attempt_log="${base_log%.ndjson}-session-$attempt-$RUN_ID.ndjson"
      attempt_prompt+=$'\nA previous OpenCode session ended unexpectedly. Inspect the current branch and worktree, preserve valid completed work, and finish the same task. Do not start over blindly.'
    fi

    if run_opencode_session "$session_title-session-$attempt" "$attempt_prompt" "$attempt_log"; then
      return 0
    fi

    if (( attempt >= MAX_SESSION_ATTEMPTS )); then
      if jq -se 'any(.[]; .type == "error" and .error.data.isRetryable == true)' "$ACTIVE_LOG" >/dev/null 2>&1; then
        touch "$RUN_INFRA_MARKER"
      fi
      die "OpenCode failed after $MAX_SESSION_ATTEMPTS session attempts."
    fi
    printf 'Starting a fresh OpenCode session in %ss, attempt %s of %s.\n' \
      "$SESSION_RETRY_DELAY" "$((attempt + 1))" "$MAX_SESSION_ATTEMPTS" >&2
    sleep "$SESSION_RETRY_DELAY"
    attempt=$((attempt + 1))
  done
}

read_pr_checks() {
  local pr_url="$1"
  local attempt=1
  local delay="$GH_RETRY_DELAY"
  local check_output=""
  local check_status=0

  while true; do
    if capture_once check_output \
      gh pr checks "$pr_url" --json name,bucket,workflow,link,startedAt; then
      check_status=0
    else
      check_status=$?
    fi

    # gh exits 1 for failed checks and 8 for pending checks, but still emits
    # usable JSON. An empty check set is the odd case: gh exits 1 and emits a
    # human-readable sentence instead of JSON.
    if jq -e 'type == "array"' <<<"$check_output" >/dev/null 2>&1; then
      CHECKS_JSON="$check_output"
      return 0
    fi
    if grep -Fqi 'no checks reported' <<<"$check_output"; then
      CHECKS_JSON='[]'
      return 0
    fi

    if (( attempt >= GH_RETRY_ATTEMPTS )); then
      printf '%s\n' "$check_output" >&2
      printf 'Could not read PR checks after %s attempts, last exit status %s.\n' \
        "$attempt" "$check_status" >&2
      return 1
    fi

    printf 'Could not read PR checks, retrying in %ss, attempt %s of %s.\n' \
      "$delay" "$attempt" "$GH_RETRY_ATTEMPTS" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    (( delay < 30 )) && delay=$((delay * 2))
    (( delay > 30 )) && delay=30
  done
}

filter_core_checks() {
  jq -c --arg advisory "$ADVISORY_CHECK_REGEX" \
    '[.[] | select((.name | test($advisory)) | not)]'
}

core_pending_count() {
  jq '[.[] | select(.bucket == "pending")] | length' <<<"$1"
}

wait_for_checks() {
  local pr_url="$1"
  local expected_head_sha="$2"
  local discovery_deadline=$((SECONDS + CHECK_DISCOVERY_TIMEOUT))
  local check_deadline=$((SECONDS + CHECK_TIMEOUT))
  local last_check_signature=""
  local last_terminal_signature=""
  local settled_since=-1
  local core_checks='[]'
  local core_check_count=0
  local check_signature=""
  local failed_check_count=0
  local pending_check_count=0
  local unknown_check_count=0
  local pr_number=""
  local review_pages='[]'
  local reviews_json='[]'
  local human_changes_count=0
  local coderabbit_state=""
  local gate_meta=""

  LAST_GATE_REASON=""

  while true; do
    capture_with_retry gate_meta gh pr view "$pr_url" --json headRefOid,mergeable,mergeStateStatus \
      || die "Could not verify the PR head while checking CI."
    [[ "$(jq -r .headRefOid <<<"$gate_meta")" == "$expected_head_sha" ]] || die "The PR head changed while checking CI."
    if jq -e '.mergeable == "CONFLICTING" or .mergeStateStatus == "BEHIND"' <<<"$gate_meta" >/dev/null; then
      LAST_GATE_REASON="Merge origin/$BASE_BRANCH into this branch, resolve conflicts, and run tests."
      return 1
    fi
    read_pr_checks "$pr_url" || die "Could not read CI checks for $pr_url."
    core_checks="$(filter_core_checks <<<"$CHECKS_JSON")" \
      || die "Could not filter CI checks."
    core_check_count="$(jq 'length' <<<"$core_checks")"

    if [[ "$core_check_count" -eq 0 ]]; then
      if (( SECONDS < discovery_deadline )); then
        sleep "$CHECK_POLL_INTERVAL"
        continue
      fi

      if [[ "$ALLOW_NO_CHECKS" == "1" ]]; then
        printf 'No non-advisory CI checks appeared; continuing because ALLOW_NO_CHECKS=1.\n'
        break
      fi
      touch "$RUN_INFRA_MARKER"
      die "No non-advisory CI checks appeared within ${CHECK_DISCOVERY_TIMEOUT}s."
    fi

    check_signature="$(
      jq -r 'sort_by(.name) | map(.name + ":" + .bucket) | join("|")' <<<"$core_checks"
    )"
    if [[ "$check_signature" != "$last_check_signature" ]]; then
      printf '\nProject CI:\n'
      jq -r '.[] | "  " + .name + "  " + .bucket' <<<"$core_checks"
      last_check_signature="$check_signature"
    fi

    unknown_check_count="$(
      jq '[.[] | select(.bucket != "pass" and .bucket != "fail" and .bucket != "pending" and .bucket != "skipping" and .bucket != "cancel")] | length' <<<"$core_checks"
    )"
    [[ "$unknown_check_count" -eq 0 ]] || die "GitHub returned an unknown CI check state."

    failed_check_count="$(
      jq '[.[] | select(.bucket == "fail" or .bucket == "cancel")] | length' <<<"$core_checks"
    )"
    if [[ "$failed_check_count" -gt 0 ]]; then
      LAST_GATE_REASON="Project CI has a failed or cancelled check."
      printf '%s\n' "$LAST_GATE_REASON" >&2
      return 1
    fi

    pending_check_count="$(core_pending_count "$core_checks")"
    if [[ "$pending_check_count" -gt 0 ]]; then
      settled_since=-1
      last_terminal_signature=""
    else
      # Jobs can register a few seconds apart. Wait for the complete terminal
      # check set to remain unchanged before using the administrator merge override.
      if [[ "$check_signature" != "$last_terminal_signature" ]]; then
        last_terminal_signature="$check_signature"
        settled_since=$SECONDS
        if [[ "$CHECK_SETTLE_SECONDS" -gt 0 ]]; then
          printf 'All visible project CI passed. Waiting %ss for late jobs.\n' "$CHECK_SETTLE_SECONDS"
        fi
      fi
      if (( SECONDS - settled_since >= CHECK_SETTLE_SECONDS )); then
        break
      fi
    fi

    if (( SECONDS >= check_deadline )); then
      touch "$RUN_INFRA_MARKER"
      die "Project CI did not finish within ${CHECK_TIMEOUT}s."
    fi
    sleep "$CHECK_POLL_INTERVAL"
  done

  # CodeRabbit is advisory because its free-tier run may be absent or stop. If it
  # has requested changes on this exact commit, give the agent a chance to respond.
  # A request on an older commit cannot block a repaired head.
  capture_with_retry pr_number gh pr view "$pr_url" --json number --jq .number \
    || die "Could not read the PR number."
  capture_with_retry review_pages \
    gh api --paginate \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "repos/$REPO/pulls/$pr_number/reviews?per_page=100" \
    || die "Could not read PR reviews."
  reviews_json="$(jq -sc 'add // []' <<<"$review_pages")" \
    || die "Could not parse PR reviews."
  human_changes_count="$(
    jq '
      [
        .[]
        | select(.user.login != "coderabbitai[bot]" and .user.login != "coderabbitai")
        | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED")
      ]
      | sort_by(.user.login, .submitted_at)
      | group_by(.user.login)
      | map(last)
      | map(select(.state == "CHANGES_REQUESTED"))
      | length
    ' <<<"$reviews_json"
  )"
  if [[ "$human_changes_count" -gt 0 ]]; then
    LAST_GATE_REASON="A human reviewer has an unresolved changes-requested review."
    printf '%s\n' "$LAST_GATE_REASON" >&2
    exit 78
  fi
  coderabbit_state="$(
    jq -r --arg sha "$expected_head_sha" '
      [
        .[]
        | select(.commit_id == $sha)
        | select(.user.login == "coderabbitai[bot]" or .user.login == "coderabbitai")
        | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED")
      ]
      | sort_by(.submitted_at)
      | last
      | .state // ""
    ' <<<"$reviews_json"
  )"
  if [[ "$coderabbit_state" == "CHANGES_REQUESTED" && "$expected_head_sha" != "$ACKNOWLEDGED_CODERABBIT_SHA" ]]; then
    LAST_GATE_REASON="CodeRabbit requested changes on the current PR commit."
    printf '%s\n' "$LAST_GATE_REASON" >&2
    return 1
  fi

  return 0
}

rerun_failed_workflows() {
  local pr_url="$1"
  local core_checks='[]'
  local pending_count=0
  local run_ids=""
  local run_id=""
  local old_signature=""
  local new_signature=""
  local rerun_deadline=$((SECONDS + CI_RERUN_START_TIMEOUT))

  read_pr_checks "$pr_url" || return 1
  core_checks="$(filter_core_checks <<<"$CHECKS_JSON")" || return 1
  pending_count="$(core_pending_count "$core_checks")"
  if [[ "$pending_count" -gt 0 ]]; then
    printf 'The repair session already restarted CI. Waiting for it.\n'
    return 0
  fi

  run_ids="$(
    jq -r '
      [
        .[]
        | select(.bucket == "fail" or .bucket == "cancel")
        | (.link // "")
        | try capture("/actions/runs/(?<id>[0-9]+)").id catch empty
      ]
      | unique
      | .[]
    ' <<<"$core_checks"
  )"
  if [[ -z "$run_ids" ]]; then
    printf 'No failed GitHub Actions workflow was available to rerun.\n' >&2
    return 1
  fi

  old_signature="$(
    jq -r 'sort_by(.name) | map(.name + ":" + .bucket + ":" + (.startedAt // "")) | join("|")' <<<"$core_checks"
  )"
  while IFS= read -r run_id; do
    [[ -n "$run_id" ]] || continue
    # A rerun request is not idempotent: if the first attempt reached GitHub
    # and only the response was lost, repeating it would restart jobs that
    # are already running. Ask once; the registration loop below confirms
    # the rerun from the checks it produces, so a late or lost response is
    # settled by observation instead of a second request.
    if gh run rerun "$run_id" --failed; then
      printf 'Requested a rerun of failed workflow run %s.\n' "$run_id"
    else
      printf 'The rerun request for workflow run %s failed; waiting for it to register.\n' "$run_id" >&2
    fi
  done <<<"$run_ids"

  while (( SECONDS < rerun_deadline )); do
    sleep "$CHECK_POLL_INTERVAL"
    read_pr_checks "$pr_url" || continue
    core_checks="$(filter_core_checks <<<"$CHECKS_JSON")" || continue
    pending_count="$(core_pending_count "$core_checks")"
    [[ "$pending_count" -gt 0 ]] && return 0

    new_signature="$(
      jq -r 'sort_by(.name) | map(.name + ":" + .bucket + ":" + (.startedAt // "")) | join("|")' <<<"$core_checks"
    )"
    [[ "$new_signature" != "$old_signature" ]] && return 0
  done

  printf 'The workflow rerun did not start within %ss.\n' "$CI_RERUN_START_TIMEOUT" >&2
  return 1
}

validate_pr() {
  local pr_url="$1"
  local issue_number="$2"
  local expected_branch="$3"
  local closing_line="Closes #$issue_number"
  local pr_meta=""
  local valid_pr=""

  # GitHub can take a few seconds to populate closingIssuesReferences after PR
  # creation. Validate the exact closing line immediately, then prove that the
  # issue closed after merge in finish_pr.
  capture_with_retry pr_meta gh pr view "$pr_url" --json baseRefName,headRefName,isDraft,body,isCrossRepository \
    || die "Could not read PR metadata."
  valid_pr="$(
    jq -r \
      --arg base "$BASE_BRANCH" \
      --arg head "$expected_branch" \
      --arg closing "$closing_line" \
      '.baseRefName == $base
       and .headRefName == $head
        and (.isCrossRepository | not)
        and (.isDraft | not)
        and (((.body // "") | gsub("\r\n"; "\n") | gsub("\r"; "\n") | split("\n") | index($closing)) != null)' <<<"$pr_meta"
  )"
  [[ "$valid_pr" == "true" ]] || die "The PR does not have the expected base, head, or exact closing line."
}

repair_pr() {
  local pr_url="$1"
  local issue_number="$2"
  local expected_branch="$3"
  local expected_head_sha="$4"
  local repair_attempt="$5"
  local gate_reason="${6:-PR gate failure}"

  printf '\nPR gates failed. Starting repair attempt %s of %s.\n' "$repair_attempt" "$MAX_REPAIR_ATTEMPTS"

  # A killed session may leave useful uncommitted work. The repair prompt tells
  # the next agent to inspect and finish it before any push or merge.
  retry_command git fetch origin "$expected_branch" || die "Could not fetch origin/$expected_branch."

  if git show-ref --verify --quiet "refs/heads/$expected_branch"; then
    [[ "$(git branch --show-current)" == "$expected_branch" ]] || git switch "$expected_branch"
  else
    git switch --track -c "$expected_branch" "origin/$expected_branch"
  fi
  if [[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]]; then
    git merge --ff-only "origin/$expected_branch"
  fi

  REPAIR_BASE_SHA="$(git rev-parse HEAD)"
  if [[ "$REPAIR_BASE_SHA" != "$expected_head_sha" && -z "$(git status --porcelain=v1 --untracked-files=normal)" ]]; then
    if git merge-base --is-ancestor "$expected_head_sha" "$REPAIR_BASE_SHA"; then
      printf 'Recovering a clean local repair commit that was not pushed before the previous stop.\n'
      retry_command git push origin "$expected_branch" || die "Could not push the recovered repair commit."
      REPAIRED_HEAD_SHA="$REPAIR_BASE_SHA"
      return 0
    fi
    die "The local repair branch has diverged from the PR head."
  fi

  ISSUE_URL="https://github.com/$REPO/issues/$issue_number"
  REPAIR_LOG="$RUN_LOG_DIR/issue-$issue_number-repair-$repair_attempt-$RUN_ID.ndjson"
  printf -v REPAIR_PROMPT '%s\n' \
    "Use the implement skill to repair this existing pull request: $pr_url" \
    "The original ticket is: $ISSUE_URL" \
    "The controller reported: $gate_reason" \
    "This is repair attempt $repair_attempt of $MAX_REPAIR_ATTEMPTS. Read every failed or cancelled GitHub Actions log, all PR review summaries, and every unresolved inline review thread. Use the GitHub CLI to fetch details that are not in the page summary." \
    "Fix every actionable failure within the ticket's scope. Address root causes; do not weaken, delete, or skip tests and do not dismiss valid review feedback. Treat infrastructure-only failures separately and rerun or explain them without changing unrelated code." \
    "Run the relevant focused tests and repository checks. Use the code-review skill before finishing. If code or documentation changes, commit the repair. Leave a clean worktree." \
    "Inspect and finish any uncommitted work from previous sessions. Preserve valid completed changes." \
    "Do not close or unassign the issue. Do not push, create another PR, merge, or send comments or messages. Do not ask questions in this unattended run."

  run_opencode_resilient "dotrelay-issue-$issue_number-repair-$repair_attempt" "$REPAIR_PROMPT" "$REPAIR_LOG"
  REPAIR_COUNT="$repair_attempt"
  save_checkpoint

  [[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]] || die "OpenCode left uncommitted repair changes."
  [[ "$(git branch --show-current)" == "$expected_branch" ]] || die "OpenCode changed the repair branch."
  REPAIRED_HEAD_SHA="$(git rev-parse HEAD)"
  if [[ "$REPAIRED_HEAD_SHA" == "$REPAIR_BASE_SHA" ]]; then
    if [[ "$gate_reason" == CodeRabbit* ]]; then
      ACKNOWLEDGED_CODERABBIT_SHA="$expected_head_sha"
      save_checkpoint
      printf 'The agent found no CodeRabbit change to commit. Treating that review as advisory for this commit.\n'
      return 0
    fi
    printf 'The repair session made no commit. Trying a clean rerun of failed GitHub Actions jobs.\n'
    rerun_failed_workflows "$pr_url" \
      || die "The repair made no commit and failed CI could not be rerun."
    return 0
  fi
  git merge-base --is-ancestor "$REPAIR_BASE_SHA" "$REPAIRED_HEAD_SHA" || die "The repair commit does not descend from the PR head."

  retry_command git push origin "$expected_branch" || die "Could not push the repair commit."

  PUSH_DEADLINE=$((SECONDS + 60))
  while true; do
    capture_with_retry REMOTE_PR_HEAD gh pr view "$pr_url" --json headRefOid --jq .headRefOid \
      || die "Could not read the PR head after pushing a repair."
    [[ "$REMOTE_PR_HEAD" == "$REPAIRED_HEAD_SHA" ]] && break
    (( SECONDS < PUSH_DEADLINE )) || die "GitHub did not update the PR head after the repair push."
    sleep 2
  done

  printf 'Pushed repair commit %s to %s.\n' "$REPAIRED_HEAD_SHA" "$pr_url"
}

finish_pr() {
  local pr_url="$1"
  local issue_number="$2"
  local expected_branch="$3"
  local expected_head_sha="$4"
  local repair_attempt="${REPAIR_COUNT:-0}"
  local pr_head_sha=""
  local pr_state=""
  local issue_state=""
  local merge_deadline=0
  local issue_close_deadline=0

  validate_pr "$pr_url" "$issue_number" "$expected_branch"
  if [[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]]; then
    git merge --ff-only "origin/$expected_branch"
  fi
  # Finish interrupted edits and push clean local commits before trusting remote CI.
  if [[ -n "$(git status --porcelain=v1 --untracked-files=normal)" || \
        "$(git rev-parse HEAD)" != "$expected_head_sha" ]]; then
    repair_pr "$pr_url" "$issue_number" "$expected_branch" "$expected_head_sha" "$repair_attempt" "Finish interrupted local work."
    expected_head_sha="$REPAIRED_HEAD_SHA"
  fi
  while ! wait_for_checks "$pr_url" "$expected_head_sha"; do
    repair_attempt=$((repair_attempt + 1))
    (( repair_attempt <= MAX_REPAIR_ATTEMPTS )) || die "PR gates still fail after $MAX_REPAIR_ATTEMPTS repair attempts."

    repair_pr "$pr_url" "$issue_number" "$expected_branch" "$expected_head_sha" "$repair_attempt" "$LAST_GATE_REASON"
    expected_head_sha="$REPAIRED_HEAD_SHA"
    validate_pr "$pr_url" "$issue_number" "$expected_branch"
  done

  capture_with_retry pr_head_sha gh pr view "$pr_url" --json headRefOid --jq .headRefOid \
    || die "Could not verify the PR head before merging."
  [[ "$pr_head_sha" == "$expected_head_sha" ]] || die "The PR head changed after the OpenCode run."
  capture_with_retry ISSUE_DETAILS gh api "repos/$REPO/issues/$issue_number" || die "Could not recheck issue ownership before merge."
  if ! jq -e --arg login "$RUN_ISSUE_LOGIN" '.state == "open" and (.assignees | length == 1 and .[0].login == $login)
    and any(.labels[]?; .name == "ready-for-agent") and .issue_dependencies_summary.blocked_by == 0' <<<"$ISSUE_DETAILS" >/dev/null; then
    printf 'Issue ownership or readiness changed before merge.\n' >&2
    exit 78
  fi

  git switch "$BASE_BRANCH"
  # Respect server-side branch protection by default, including required checks
  # that have not registered yet. Administrator bypass is an explicit opt-in.
  MERGE_FLAGS=()
  [[ "${MERGE_ADMIN:-0}" != "1" ]] || MERGE_FLAGS+=(--admin)
  # A merge is not idempotent: after it succeeds, --match-head-commit can no
  # longer match, so repeating the request would fail for the wrong reason.
  # Ask once; the state check below recovers a lost response.
  if ! gh pr merge "$pr_url" \
    "--$MERGE_METHOD" \
    ${MERGE_FLAGS[@]+"${MERGE_FLAGS[@]}"} \
    --match-head-commit "$expected_head_sha"; then
    # The merge request may have reached GitHub even if the response was lost.
    capture_with_retry pr_state gh pr view "$pr_url" --json state --jq .state \
      || die "The merge command failed and the PR state could not be checked."
    [[ "$pr_state" == "MERGED" ]] || die "GitHub did not merge $pr_url"
  fi

  merge_deadline=$((SECONDS + MERGE_TIMEOUT))
  while true; do
    capture_with_retry pr_state gh pr view "$pr_url" --json state --jq .state \
      || die "Could not read PR state while waiting for the merge."
    [[ "$pr_state" == "MERGED" ]] && break
    [[ "$pr_state" == "OPEN" ]] || die "PR state is $pr_state, not MERGED."
    (( SECONDS < merge_deadline )) || die "PR did not merge within ${MERGE_TIMEOUT}s."
    sleep "$CHECK_POLL_INTERVAL"
  done

  issue_close_deadline=$((SECONDS + ISSUE_CLOSE_TIMEOUT))
  while true; do
    capture_with_retry issue_state gh issue view "$issue_number" --json state --jq .state \
      || die "Could not read issue state after merging."
    [[ "$issue_state" == "CLOSED" ]] && break
    (( SECONDS < issue_close_deadline )) || die "Issue #$issue_number did not close within ${ISSUE_CLOSE_TIMEOUT}s after merge."
    sleep "$CHECK_POLL_INTERVAL"
  done

  printf 'Merged issue #%s. Starting the next issue in a fresh OpenCode session.\n' "$issue_number"
}

REPAIR_COUNT=0
BASE_SHA=""
if [[ -f "$WORKER_STATE" ]]; then
  BASE_SHA="$(jq -r .base "$WORKER_STATE")"
  REPAIR_COUNT="$(jq -r .repairs "$WORKER_STATE")"
  ACKNOWLEDGED_CODERABBIT_SHA="$(jq -r '.advisory // ""' "$WORKER_STATE")"
fi

while true; do
  ACTIVE_ISSUE="$RUN_ISSUE_NUMBER"
  ACTIVE_BRANCH="agent/issue-$ACTIVE_ISSUE"
  ACTIVE_LOG="$RUN_LOG_DIR/issue-$ACTIVE_ISSUE-$RUN_ID.ndjson"

  if [[ -n "$(git status --porcelain=v1 --untracked-files=normal)" && \
        "$(git branch --show-current)" != "$ACTIVE_BRANCH" ]]; then
    printf 'Unfinished work is on an unexpected branch; inspect this checkout.\n' >&2
    exit 78
  fi

  retry_command git fetch --prune origin || die "Could not fetch origin."
  capture_with_retry ISSUE_DETAILS gh api "repos/$REPO/issues/$ACTIVE_ISSUE" || die "Could not check selected issue."
  [[ "$(jq -r .state <<<"$ISSUE_DETAILS")" != "closed" ]] || exit 0
  if ! jq -e --arg login "$RUN_ISSUE_LOGIN" 'all(.assignees[]?; .login == $login)
    and any(.labels[]?; .name == "ready-for-agent") and .issue_dependencies_summary.blocked_by == 0' <<<"$ISSUE_DETAILS" >/dev/null; then
    printf 'Issue ownership or readiness changed before resuming.\n' >&2
    exit 78
  fi
  if [[ "$(jq '.assignees | length' <<<"$ISSUE_DETAILS")" == "0" ]]; then
    retry_command gh issue edit "$ACTIVE_ISSUE" --add-assignee @me >/dev/null || die "Could not claim selected issue."
  fi

  # Recover cleanly from a stopped controller after it opened the PR. The
  # agent/issue-N branch namespace belongs to this script.
  capture_with_retry RESUME_JSON \
    gh pr list \
      --state all \
      --base "$BASE_BRANCH" \
      --head "$ACTIVE_BRANCH" \
      --author @me \
      --limit 100 \
      --json number,url,headRefName,headRefOid,state \
      --jq 'sort_by(.number) | last // empty' \
    || die "Could not look for an open agent PR to resume."
  if [[ -n "$RESUME_JSON" ]]; then
    PR_URL="$(jq -r .url <<<"$RESUME_JSON")"
    ACTIVE_BRANCH="$(jq -r .headRefName <<<"$RESUME_JSON")"
    ACTIVE_ISSUE="${ACTIVE_BRANCH#agent/issue-}"
    HEAD_SHA="$(jq -r .headRefOid <<<"$RESUME_JSON")"
    if [[ "$(jq -r .state <<<"$RESUME_JSON")" == "CLOSED" ]]; then
      printf 'The existing PR was closed without merging; leaving it for inspection.\n' >&2
      exit 78
    fi
    if [[ "$(jq -r .state <<<"$RESUME_JSON")" == "MERGED" ]]; then
      capture_with_retry ISSUE_STATE gh issue view "$ACTIVE_ISSUE" --json state --jq .state || die "Could not verify linked issue closure."
      [[ "$ISSUE_STATE" != "CLOSED" ]] || exit 0
      touch "$RUN_INFRA_MARKER"
      die "PR merged; waiting for GitHub to close the linked issue."
    fi
    if git show-ref --verify --quiet "refs/heads/$ACTIVE_BRANCH"; then
      [[ "$(git branch --show-current)" == "$ACTIVE_BRANCH" ]] || git switch "$ACTIVE_BRANCH"
    else
      git switch --track -c "$ACTIVE_BRANCH" "origin/$ACTIVE_BRANCH"
    fi
    if [[ -z "$BASE_SHA" ]]; then
      BASE_SHA="$(git merge-base HEAD "origin/$BASE_BRANCH")"
      save_checkpoint
    fi

    printf '\nResuming open PR for issue #%s: %s\n' "$ACTIVE_ISSUE" "$PR_URL"
    finish_pr "$PR_URL" "$ACTIVE_ISSUE" "$ACTIVE_BRANCH" "$HEAD_SHA"
    exit 0
  fi

  capture_with_retry ISSUE_JSON gh api "repos/$REPO/issues/$ACTIVE_ISSUE" || die "Could not read selected issue."

  ACTIVE_ISSUE="$(jq -r .number <<<"$ISSUE_JSON")"
  ISSUE_TITLE="$(jq -r .title <<<"$ISSUE_JSON")"
  ISSUE_URL="$(jq -r .html_url <<<"$ISSUE_JSON")"
  ISSUE_PRIORITY="$(jq -r '(.body // "") | capture("Priority:[[:space:]]*P(?<n>[0-9]+)"; "i").n // "?"' <<<"$ISSUE_JSON")"
  ACTIVE_BRANCH="agent/issue-$ACTIVE_ISSUE"
  ACTIVE_LOG="$RUN_LOG_DIR/issue-$ACTIVE_ISSUE-$RUN_ID.ndjson"

  printf '\nSelected P%s issue #%s: %s\n%s\n' \
    "$ISSUE_PRIORITY" "$ACTIVE_ISSUE" "$ISSUE_TITLE" "$ISSUE_URL"

  # Re-read immediately before claiming. This narrows the race with another worker.
  ISSUE_DETAILS=""
  capture_with_retry ISSUE_DETAILS \
    gh api -H 'Accept: application/vnd.github+json' "repos/$REPO/issues/$ACTIVE_ISSUE" \
    || die "Could not re-read issue #$ACTIVE_ISSUE before claiming it."
  STILL_FREE="$(
    jq -r --arg login "$RUN_ISSUE_LOGIN" '
        .state == "open"
        and any(.labels[]?; .name == "ready-for-agent")
        and all(.assignees[]?; .login == $login)
        and (.issue_dependencies_summary != null)
        and (.issue_dependencies_summary.blocked_by == 0)
      ' <<<"$ISSUE_DETAILS"
  )"
  [[ "$STILL_FREE" == "true" ]] || die "Issue #$ACTIVE_ISSUE was claimed or blocked by another worker."

  retry_command gh issue edit "$ACTIVE_ISSUE" --add-assignee @me >/dev/null \
    || die "Could not assign issue #$ACTIVE_ISSUE."
  capture_with_retry ISSUE_DETAILS gh api "repos/$REPO/issues/$ACTIVE_ISSUE" || die "Could not verify issue ownership."
  jq -e --arg login "$RUN_ISSUE_LOGIN" '.assignees | length == 1 and .[0].login == $login' <<<"$ISSUE_DETAILS" >/dev/null \
    || die "Issue claim changed; refusing concurrent work."

  if git show-ref --verify --quiet "refs/heads/$ACTIVE_BRANCH"; then
    [[ "$(git branch --show-current)" == "$ACTIVE_BRANCH" ]] || git switch "$ACTIVE_BRANCH"
  elif git show-ref --verify --quiet "refs/remotes/origin/$ACTIVE_BRANCH"; then
    git switch --track -c "$ACTIVE_BRANCH" "origin/$ACTIVE_BRANCH"
  else
    git switch -c "$ACTIVE_BRANCH" "origin/$BASE_BRANCH"
  fi
  if [[ -z "$BASE_SHA" ]]; then
    BASE_SHA="$(git merge-base HEAD "origin/$BASE_BRANCH")"
    save_checkpoint
  fi

  printf -v PROMPT '%s\n' \
    "Use the implement skill to implement exactly this ticket: $ISSUE_URL" \
    "Expected title: $ISSUE_TITLE" \
    "Resolve the full URL and confirm the title before editing. Read the issue body, every comment, AGENTS.md, and the linked repository docs. Work only on this issue against the current branch, which starts at the latest origin/$BASE_BRANCH." \
    "Run the tests and checks required by the issue and repository. The implement skill must finish by committing the work. Leave a clean worktree." \
    "Do not assign or unassign issues. Do not close the issue. Do not push, create a PR, or merge. The controller handles those steps." \
    "Do not ask questions in this unattended run. If the issue is already satisfied or a material decision is missing, make no speculative change and explain the blocker in your final response."

  PROMPT+=$'\nInspect and finish any existing commits or uncommitted work left by a previous session. Preserve valid completed work. Do not send comments or messages.'

  run_opencode_resilient "dotrelay-issue-$ACTIVE_ISSUE" "$PROMPT" "$ACTIVE_LOG"

  [[ -z "$(git status --porcelain=v1 --untracked-files=normal)" ]] || die "OpenCode left uncommitted changes."
  [[ "$(git branch --show-current)" == "$ACTIVE_BRANCH" ]] || die "OpenCode changed the issue branch."
  HEAD_SHA="$(git rev-parse HEAD)"
  [[ "$HEAD_SHA" != "$BASE_SHA" ]] || die "OpenCode produced no commit."
  git merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA" || die "The result is not based on the selected main commit."

  retry_command git push --set-upstream origin "$ACTIVE_BRANCH" \
    || die "Could not push $ACTIVE_BRANCH."

  capture_with_retry EXISTING_PR \
    gh pr list --state open --head "$ACTIVE_BRANCH" --json url --jq '.[0].url // empty' \
    || die "Could not check for an existing PR for $ACTIVE_BRANCH."
  if [[ -n "$EXISTING_PR" ]]; then
    PR_URL="$EXISTING_PR"
  else
    printf -v PR_BODY 'Closes #%s\n\nImplemented from the agent-ready ticket in a fresh OpenCode session.' "$ACTIVE_ISSUE"
    PR_BODY_FILE="$RUN_LOG_DIR/issue-$ACTIVE_ISSUE-$RUN_ID-pr.md"
    printf '%s\n' "$PR_BODY" >"$PR_BODY_FILE"
    PR_CREATE_OUTPUT=""
    if capture_once PR_CREATE_OUTPUT \
      gh pr create \
        --base "$BASE_BRANCH" \
        --head "$ACTIVE_BRANCH" \
        --title "$ISSUE_TITLE" \
        --body-file "$PR_BODY_FILE"; then
      PR_URL="$PR_CREATE_OUTPUT"
    else
      # Creation may have succeeded even if the response was interrupted.
      capture_with_retry EXISTING_PR \
        gh pr list --state open --head "$ACTIVE_BRANCH" --json url --jq '.[0].url // empty' \
        || die "PR creation failed and recovery could not inspect the branch."
      if [[ -z "$EXISTING_PR" ]]; then
        printf '%s\n' "$PR_CREATE_OUTPUT" >&2
        die "Could not create a PR for $ACTIVE_BRANCH."
      fi
      PR_URL="$EXISTING_PR"
      printf 'Recovered PR creation after an interrupted GitHub response.\n'
    fi
  fi

  printf 'Opened %s\n' "$PR_URL"
  finish_pr "$PR_URL" "$ACTIVE_ISSUE" "$ACTIVE_BRANCH" "$HEAD_SHA"
  exit 0
done
