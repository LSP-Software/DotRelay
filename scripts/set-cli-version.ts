import { join } from "node:path";

const tag = Bun.argv[2];
if (
  !tag ||
  !/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(
    tag,
  )
)
  throw new Error("expected a strict SemVer release tag such as v1.2.3");

const path = join(
  import.meta.dir,
  "..",
  "packages",
  "dotrelay",
  "package.json",
);
const packageJson = (await Bun.file(path).json()) as Record<string, unknown>;
packageJson.version = tag.slice(1);
await Bun.write(path, `${JSON.stringify(packageJson, null, 2)}\n`);
