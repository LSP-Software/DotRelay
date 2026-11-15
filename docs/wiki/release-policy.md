# Release policy

`main` is protected. Changes arrive through pull requests and every required CI gate must pass;
routine bypasses are forbidden. An emergency bypass is exceptional and requires a corrective pull
request with an explanation.

Production releases are tag-only. A tag matching `v*.*.*` starts the release workflow; the workflow
checks that the tagged commit is an ancestor of `main`, reruns `bun run verify`, and builds native
CLI binaries on Linux, macOS, and Windows. It publishes all three binaries as GitHub Release assets
and publishes the intentional `@dotrelay/cli` npm selector containing the matching platform binaries.
Merging to `main` never deploys production.
The workflow does not enforce immutable tag references or strict SemVer beyond the tag glob.
Before the build matrix runs, the workflow records the tag's release version in the npm
selector and stamps each compiled binary with it, so `dotrelay --version` agrees with the
tagged/npm release the operator installed. Platform-specific npm binaries are staged with
`bun run package:cli`; the release workflow verifies the selector and publishes the package
only after the cross-platform build matrix completes.

Before a production tag is approved, the release owner must attach the security review approval for
the observability privacy boundary to the release record. The approval must verify that Application
Diagnostic Events, Audit Facts, Security Request Logs, hosted cleanup, self-hosted cleanup, and
access controls still match the canonical Wiki policy. A missing approval or a hosted/self-hosted
parity exception blocks the production release. The `security-review` GitHub Environment used by the
publish job must be configured with the security owner as a required reviewer; its deployment
approval is the release evidence. The environment must also define the protected variables
`SECURITY_REVIEW_APPROVED_SHA`, set to the exact commit the review approved, and
`SECURITY_REVIEW_REPORT_SHA256`, the 64-character lowercase hex SHA-256 of the review report. The
image, publish and production deploy jobs check after the environment gate that the approved SHA
equals the tagged commit and that the report hash is well formed, and refuse to continue otherwise.
The publish job binds both values into the release evidence.

Alpha, beta and rc tags are versions of the production service at `dotrelay.dev`: every approved
`v*` tag builds for the production origins and deploys production. Prereleases publish versioned
images and `latest-alpha`, never `latest-stable`, and skip only the independent-review check, so
production admission stays limited to the alpha allow-list until a reviewed stable release. On npm,
alpha, beta and rc builds move `latest` until the first stable version exists; after that they use
their own tag. Dev builds from `main` only ever use `dev`. Release workflows serialize across all
release tags; the concurrency group uses `queue: max` so pending releases are retained rather than
replaced.
