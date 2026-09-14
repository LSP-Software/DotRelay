# The CLI never re-publishes automatically after a stale-head rejection

Status: accepted

If the Environment's head moves between the CLI's Baseline Reconciliation and the service
accepting the merged Publication, the CLI fails with a clear message instead of re-syncing and
re-publishing; the next run reconciles again from the recorded Publication Baseline. Unlike the
web client, which auto-retries into its conflict UI, the CLI will never act on a state the
operator did not review, keeping "never silently retarget a preexisting draft" true for the
re-merge loop as well as for the first attempt.
