# Release policy

`main` is protected. Changes normally arrive through pull requests and every required CI gate must
pass; routine bypasses are forbidden. Repository administrator enforcement is intentionally disabled
for an exceptional manual override when an urgent change cannot wait for a required gate. The
administrator who uses the override must record the reason, affected pull request and failed or
unavailable requirement, then open a corrective pull request with an explanation and validation
evidence.

The override does not permit force-pushes or branch deletion. The branch still requires linear
history, conversation resolution, and one approving review under the normal protected-branch policy.
Use the GitHub pull request merge control as an administrator only when the emergency criteria are
met; do not change the required-check list or other protection settings as part of the override.

Production releases are tag-only. A tag matching `v*.*.*` starts the release workflow; the workflow
checks that the tagged commit is an ancestor of `main`, reruns `bun run verify`, and publishes the
single `apps/cli/dist/dotrelay` binary built on `ubuntu-latest` as a GitHub Release asset. Merging to
`main` never deploys production.

The current workflow does not enforce immutable tag references or strict SemVer beyond the tag glob,
and it does not publish platform-specific artifacts or an npm distribution. Those guarantees require
additional release-workflow and repository-policy changes before they can be promised.
