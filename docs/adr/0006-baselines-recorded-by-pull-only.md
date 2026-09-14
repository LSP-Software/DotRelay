# Draft baselines are recorded by pull and never refreshed by publication

Status: accepted

The CLI records a draft's Publication Baseline in exactly two cases: when `pull` writes the file
from a verified head, and when `push`/`init` meets a file with no recorded baseline, persisting
the invocation-start head as a fallback. A successful publication never re-records the baseline,
because the input file does not derive from the new head; refreshing it would make a teammate's
later addition look like a local deletion on the next push, re-entering the deletion mode issue
#88 fixes. A recorded baseline that is no longer verifiable in the Environment's history (for
example after a History Trust Reset) is treated as unrecorded: the CLI shows a visible notice and
falls back to the invocation-start head.

## Considered options

- Refresh the baseline after a successful publication: the natural optimization, rejected for the
  deletion-misattribution reason above.
- Keep fallback baselines invocation-local: a re-run of a failed push would re-anchor at the
  then-current head and re-attribute teammates' intervening changes as local edits.
