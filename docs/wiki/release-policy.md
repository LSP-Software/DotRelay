# Release policy

`main` is protected. Changes arrive through pull requests and every required CI gate must pass;
routine bypasses are forbidden. An emergency bypass is exceptional and requires a corrective pull
request with an explanation.

Production releases are tag-only. Only an immutable SemVer tag such as `v1.2.3`, pointing to a
fully verified commit on `main`, starts the release workflow. The workflow reruns release-critical
checks and promotes the exact artifacts built by that run. Merging to `main` never deploys
production.

The CLI is compiled into self-contained native binaries and the release workflow publishes the
supported platform artifacts plus a small npm distribution that selects the platform binary. No
production release is permitted before the final MVP verification and security evidence ticket is
complete.
