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
