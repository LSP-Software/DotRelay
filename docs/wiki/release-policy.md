# Release policy

`main` is protected. Changes arrive through pull requests and every required CI gate must pass;
routine bypasses are forbidden. An emergency bypass is exceptional and requires a corrective pull
request with an explanation.

Production releases are tag-only. A tag matching `v*.*.*` starts the release workflow; the workflow
checks that the tagged commit is an ancestor of `main`, reruns `bun run verify`, and builds native
CLI binaries for every release target (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`,
`win32-x64`). It publishes them as GitHub Release assets and to npm as one
`@dotrelay/cli-<platform>-<arch>` package per target plus the `@dotrelay/cli` selector that pins
them as exact optional dependencies.
Merging to `main` never deploys production.
The workflow does not enforce immutable tag references or strict SemVer beyond the tag glob.
Before the build matrix runs, the workflow records the tag's release version in the npm
selector and stamps each compiled binary with it, so `dotrelay --version` agrees with the
tagged/npm release the operator installed. Each build job stages its binary with
`bun run package:cli`. After the matrix completes, the publish job assembles the npm packages with
`bun run package:cli:npm --all` (which fails if a target is missing), installs the packed selector
with the runner's platform package and runs it (`scripts/test-cli-package.ts`), creates the draft
GitHub release, publishes to npm, and only then publishes the GitHub release.
`scripts/publish-cli.ts` publishes every platform package first and the selector last, so a
published selector never pins a missing package. A re-run after a partial failure skips any
`<package>@<version>` that `npm view` already finds; nothing is ever unpublished.

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

The release's verify job runs `bun run security:audit` on the tagged commit. The packaged CLI
binaries are executed only by the `smoke-cli-package` job, which has read-only permissions, no
environment and no secrets; the publish job, which holds write, OIDC and attestation permissions,
never runs them, and `npm pack` and `npm publish` there run with `--ignore-scripts`.

Alpha, beta and rc tags are versions of the production service at `dotrelay.dev`: every approved
`v*` tag builds for the production origins and deploys production. Prereleases publish versioned
images and `latest-alpha`, never `latest-stable`, and skip only the independent-review check, so
production admission stays limited to the alpha allow-list until a reviewed stable release. On npm,
alpha, beta and rc builds move `latest` until the first stable version exists; after that they use
their own tag. Dev builds from `main` only ever use `dev`. Release workflows serialize across all
release tags; the concurrency group uses `queue: max` so pending releases are retained rather than
replaced.

## npm packages and trusted publishing

CI publishes these six packages, all at the same version:

| Package                      | Contents                   |
| ---------------------------- | -------------------------- |
| `@dotrelay/cli-linux-x64`    | Linux x64 (glibc) binary   |
| `@dotrelay/cli-linux-arm64`  | Linux arm64 (glibc) binary |
| `@dotrelay/cli-darwin-x64`   | macOS x64 binary           |
| `@dotrelay/cli-darwin-arm64` | macOS arm64 binary         |
| `@dotrelay/cli-win32-x64`    | Windows x64 binary         |
| `@dotrelay/cli`              | selector; published last   |

Trusted publishing cannot create a package, so each new package needs a one-time bootstrap by an
owner of the `@dotrelay` npm scope before CI can publish it. `@dotrelay/cli` was created the same
way: a placeholder `0.0.0-bootstrap` published by hand, then validated from CI by the manual
`npm-trust-bootstrap` job in `ci.yml` (`0.0.0-bootstrap.<run>.<attempt>` under the `bootstrap`
dist-tag). For the five `@dotrelay/cli-<platform>-<arch>` packages:

1. Create the packages. Logged in to npm as a scope owner with two-factor authentication, publish
   a placeholder of each (npm asks for a one-time password per publish):

   ```sh
   for name in @dotrelay/cli-linux-x64 @dotrelay/cli-linux-arm64 @dotrelay/cli-darwin-x64 \
     @dotrelay/cli-darwin-arm64 @dotrelay/cli-win32-x64; do
     dir=$(mktemp -d)
     printf '{"name":"%s","version":"0.0.0-bootstrap","description":"Placeholder. Install @dotrelay/cli instead.","repository":{"type":"git","url":"git+https://github.com/LSP-Software/DotRelay.git"}}\n' "$name" >"$dir/package.json"
     npm publish "$dir" --access public --tag bootstrap
   done
   ```

   npm points `latest` at a package's first version whatever the tag; that is harmless here
   because the selector pins exact versions, and the first stable release moves it.

2. On npmjs.com open **`<package>` → Settings → Trusted publishing → GitHub Actions** and add two
   trusted publishers, both with organization `LSP-Software` and repository `DotRelay`:

   | Workflow filename | Environment       | Publishes                       |
   | ----------------- | ----------------- | ------------------------------- |
   | `release.yml`     | `security-review` | tagged releases and prereleases |
   | `ci.yml`          | (none)            | the `dev` packages from `main`  |

3. In the same settings choose **Publishing access → Require two-factor authentication and disallow
   tokens**.

4. Validate the publishers. npm drops a new trusted publisher that does not publish within two
   days, which is why `npm-trust-bootstrap` exists. That job publishes only `@dotrelay/cli`; extend
   it in a separate change to publish the same placeholder under the `bootstrap` tag for each
   platform package, then run it from the Actions tab. The next push to `main` (the `ci.yml`
   publisher) and the next release tag (the `release.yml` publisher) also validate them.

Until every platform package has a trusted publisher for the workflow, `scripts/publish-cli.ts`
stops at the first package npm rejects. Platform packages published before it stay published; the
selector is not published, so installs keep resolving the previous version. Fix the publisher and
re-run the job.
