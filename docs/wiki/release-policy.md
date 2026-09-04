# Release policy

`main` is protected. Changes arrive through pull requests and every required CI gate must pass;
routine bypasses are forbidden. An emergency bypass is exceptional and requires a corrective pull
request with an explanation.

Production releases are tag-only. A tag matching `v*.*.*` starts the release workflow; the workflow
checks that the tagged commit is an ancestor of `main`, reruns `bun run verify`, and builds native
CLI binaries on Linux, macOS, and Windows. It publishes all three binaries as GitHub Release assets
and publishes the intentional `dotrelay` npm selector containing the matching platform binaries.
Merging to `main` never deploys production.

The workflow does not enforce immutable tag references or strict SemVer beyond the tag glob.
Platform-specific npm binaries are staged with `bun run package:cli`; the release workflow verifies
the selector and publishes the package only after the cross-platform build matrix completes.

Before a production tag is approved, the release owner must attach the security review approval for
the observability privacy boundary to the release record. The approval must verify that Application
Diagnostic Events, Audit Facts, Security Request Logs, hosted cleanup, self-hosted cleanup, and
access controls still match the canonical Wiki policy. A missing approval or a hosted/self-hosted
parity exception blocks the production release. The `security-review` GitHub Environment used by the
publish job must be configured with the security owner as a required reviewer; its deployment
approval is the release evidence. The environment must also define the protected variable
`SECURITY_REVIEW_APPROVAL=approved`; the publish job checks this value after the environment gate
and refuses to publish without it.
