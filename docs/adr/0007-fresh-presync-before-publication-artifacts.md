# The CLI re-syncs immediately before building publication artifacts

Status: accepted

The defect in issue #88 was not the second sync's existence but its use: adopting its head as the
expected parent and re-diffing the stale draft against its data with no reconciliation. The fix
therefore keeps a fresh sync, moved to after conflict resolution and immediately before the
artifacts are built; it supplies only (a) the remote side of the Baseline Reconciliation and
(b) the Publication's expected head. The invocation-start sync feeds draft building and
classification. A single invocation-start-only sync was rejected because any teammate publication
during the operator's review session would turn the entire run into a stale-head failure, while
the fresh sync can only change the expected parent through the explicit three-way reconciliation
it feeds.
