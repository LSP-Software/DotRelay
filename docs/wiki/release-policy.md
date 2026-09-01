# Release policy

`main` is protected. Changes arrive through pull requests and every required CI gate must pass;
routine bypasses are forbidden. An emergency bypass is exceptional and requires a corrective pull
request with an explanation.

Production releases are tag-only. A tag matching `v*.*.*` starts the release workflow; the workflow
checks that the tagged commit is an ancestor of `main`, reruns `bun run verify`, and publishes the
single `apps/cli/dist/dotrelay` binary built on `ubuntu-latest` as a GitHub Release asset. Merging to
`main` never deploys production.

The current workflow does not enforce immutable tag references or strict SemVer beyond the tag glob.
Platform-specific npm packages are staged with `bun run package:cli`; the release workflow still
publishes the standalone binary as its release asset.
