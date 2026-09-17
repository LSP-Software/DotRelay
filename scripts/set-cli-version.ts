import { join } from "node:path";

const tag = Bun.argv[2] ?? "";
const releaseTag =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.exec(
    tag,
  );
const devTag = /^v0\.0\.0-dev\.[0-9a-f]{7,40}$/.exec(tag);
let version: string | null = null;
if (devTag) {
  // A dev build is cut from a main commit and published under the npm dev
  // dist-tag; the version records the commit it was built from, so every
  // publish is a unique, orderable npm version. The dev shape is tested
  // before the release one, which would also match it.
  version = devTag[0].replace(/^v/, "");
} else if (releaseTag) {
  // A release stamps a real version into the compiled binary, so the
  // unpublished 0.0.0 placeholder is not a valid release tag.
  if (
    !(releaseTag[1] === "0" && releaseTag[2] === "0" && releaseTag[3] === "0")
  )
    version = releaseTag[0].replace(/^v/, "");
}
if (version === null)
  throw new Error(
    "expected a strict SemVer release tag such as v1.2.3, or a dev version such as v0.0.0-dev.<commit-sha>",
  );

const path = join(
  import.meta.dir,
  "..",
  "packages",
  "dotrelay",
  "package.json",
);
const packageJson = (await Bun.file(path).json()) as Record<string, unknown>;
packageJson.version = version;
await Bun.write(path, `${JSON.stringify(packageJson, null, 2)}\n`);
