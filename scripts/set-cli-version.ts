import { join } from "node:path";

const tag = Bun.argv[2];
const match =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.exec(
    tag ?? "",
  );
// A release stamps a real version into the compiled binary, so the
// unpublished 0.0.0 placeholder is not a valid release tag.
if (!match || (match[1] === "0" && match[2] === "0" && match[3] === "0"))
  throw new Error("expected a strict SemVer release tag such as v1.2.3");
const version = match[0].replace(/^v/, "");

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
