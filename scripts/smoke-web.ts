import { access } from "node:fs/promises";
import { join } from "node:path";

await access(join(import.meta.dir, "..", "apps", "web", ".next", "BUILD_ID"));
console.log("✓ web production build exists");
