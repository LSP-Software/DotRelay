# Security policy

DotRelay brokers end-to-end-encrypted secrets, so we treat security reports as a priority.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/LSP-Software/DotRelay/security/advisories/new).
Do not open a public issue, pull request, or discussion for a suspected vulnerability.

Include the affected component (CLI, web app, API, or a shared package), the version or commit,
steps to reproduce, and the impact you observed. Never include real secrets in a report.

We aim to acknowledge reports within three working days and to agree a disclosure date with you
once a fix is available.

## Supported versions

DotRelay has not yet made a stable release. Only the most recent prerelease and the `main` branch
receive security fixes.

## Scope and design

The cryptographic design and its limits are documented in [`docs/wiki/crypto.md`](docs/wiki/crypto.md)
and [`docs/wiki/trust.md`](docs/wiki/trust.md). DotRelay uses classical cryptography only and makes
no post-quantum claims.
