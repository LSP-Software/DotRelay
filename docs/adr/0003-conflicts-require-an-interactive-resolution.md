# Variable Conflicts always require an interactive resolution

Status: accepted

Under `--no-input` (and machine invocations generally), a Publication that meets a Variable
Conflict fails with a conflict error naming the Variables; the input file and the recorded
Publication Baseline are left intact. The CLI provides no `--on-conflict` policy flag and no
`--force` escape hatch for conflicts, because choosing a side of a security-relevant Value
overwrite is a human judgment this project does not delegate to policy. Automation is expected to
keep its changes disjoint from teammates' or to surface the conflict to a person.

## Considered options

- `--on-conflict=local|remote` policy flag: makes security-relevant overwrites policy-able, which
  is the failure class this issue removes.
- `--force` implying keep-local: overloads a flag whose documented meaning is approving
  deletions, and would make silent overwrites one flag away.
