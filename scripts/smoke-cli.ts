import { access } from "node:fs/promises";
import { join } from "node:path";

await access(
  join(
    import.meta.dir,
    "..",
    "apps",
    "cli",
    "dist",
    process.platform === "win32" ? "dotrelay.exe" : "dotrelay",
  ),
);
console.log("✓ CLI production binary exists");
