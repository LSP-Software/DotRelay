# Persist each draft's Publication Baseline in the state directory

Status: accepted

The CLI records, per (Environment, input file), the verified Revision from which a dotenv Draft's
content was derived — a Revision id plus head hash in the state directory, beside the existing
trusted-head file. No decoded content is ever persisted, keeping the CLI's no-plaintext-cache
policy. A hand-written file with no recorded baseline falls back to the head at invocation start,
and a recorded baseline that is no longer verifiable in the Environment's history (for example
after a History Trust Reset) degrades to that fallback with a visible notice.

## Considered options

- Marker comment inside the exported dotenv file: travels with the file, but injects machine-owned
  content into a user-edited file and silently degrades if the line is deleted.
- No persistence: fixes only the in-invocation race; pull → edit → push degrades to a two-way
  diff against the current head, re-attributing teammates' changes as local edits — the exact
  overwrite this decision prevents.
