import { readdir, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

const root = resolve(process.cwd(), "docs/wiki");
const markdownFiles: string[] = [];
const collect = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && extname(entry.name) === ".md")
      markdownFiles.push(path);
  }
};

await collect(root);
const violations: string[] = [];
for (const file of markdownFiles) {
  const source = await Bun.file(file).text();
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]?.split("#", 1)[0];
    if (
      !target ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:")
    )
      continue;
    const candidate = resolve(dirname(file), target);
    try {
      await stat(candidate);
    } catch {
      violations.push(`${file}: broken documentation link ${target}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log(
  `✓ validated ${markdownFiles.length} Wiki source pages and their links`,
);
