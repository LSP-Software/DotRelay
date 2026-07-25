import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

type WorkspaceKind = "app" | "package";
type WorkspaceManifest = {
  directory: string;
  kind: WorkspaceKind;
  name: string;
  manifest: Record<string, unknown>;
};

const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const ignoredDirectories = new Set([
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
]);
const workspaceDependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

async function findWorkspaceDirectories(
  root: string,
  group: "apps" | "packages",
): Promise<string[]> {
  const groupRoot = join(root, group);
  try {
    const entries = await readdir(groupRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(groupRoot, entry.name));
  } catch {
    return [];
  }
}

async function readManifest(
  directory: string,
  kind: WorkspaceKind,
): Promise<WorkspaceManifest> {
  const path = join(directory, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  const name =
    typeof manifest.name === "string" ? manifest.name : basename(directory);
  return { directory, kind, name, manifest };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
        await visit(join(current, entry.name));
      } else if (
        entry.isFile() &&
        sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))
      ) {
        files.push(join(current, entry.name));
      }
    }
  }
  await visit(directory);
  return files;
}

function dependencyNames(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const field of workspaceDependencyFields) {
    const dependencies = manifest[field];
    if (dependencies && typeof dependencies === "object") {
      for (const name of Object.keys(dependencies)) names.add(name);
    }
  }
  return names;
}

function workspaceDependencyMap(
  manifest: Record<string, unknown>,
): Map<string, string> {
  const dependencies = new Map<string, string>();
  for (const field of workspaceDependencyFields) {
    const values = manifest[field];
    if (values && typeof values === "object") {
      for (const [name, version] of Object.entries(values)) {
        if (typeof version === "string") dependencies.set(name, version);
      }
    }
  }
  return dependencies;
}

function importedSpecifiers(source: string): string[] {
  const imports: string[] = [];
  const pattern =
    /(?:import\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?|import\s*\(|export\s+[^"']+?\s+from\s+|require\s*\()\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier) imports.push(specifier);
  }
  return imports;
}

function cycleDescriptions(graph: Map<string, Set<string>>): string[] {
  const violations: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reported = new Set<string>();

  function visit(node: string, path: string[]): void {
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      const cycle = [...path.slice(start), node].join(" -> ");
      const key = [...new Set(path.slice(start))].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        violations.push(`workspace dependency cycle: ${cycle}`);
      }
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node) ?? [])
      visit(dependency, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) visit(node, []);
  return violations;
}

export async function validateWorkspaceBoundaries(
  root: string,
): Promise<string[]> {
  const violations: string[] = [];
  const workspaces = [
    ...(await findWorkspaceDirectories(root, "apps")).map((directory) =>
      readManifest(directory, "app"),
    ),
    ...(await findWorkspaceDirectories(root, "packages")).map((directory) =>
      readManifest(directory, "package"),
    ),
  ];
  const manifests = await Promise.all(workspaces);
  const byName = new Map(
    manifests.map((workspace) => [workspace.name, workspace]),
  );
  const graph = new Map<string, Set<string>>();

  for (const workspace of manifests) {
    const { name, manifest, kind } = workspace;
    graph.set(name, new Set());
    if (manifest.private !== true)
      violations.push(`${name}: workspace must be private`);
    if (
      kind === "package" &&
      (!manifest.exports || typeof manifest.exports !== "object")
    ) {
      violations.push(`${name}: package must define public exports`);
    }

    for (const [dependency, version] of workspaceDependencyMap(manifest)) {
      if (byName.has(dependency)) {
        graph.get(name)?.add(dependency);
        if (version !== "workspace:*") {
          violations.push(
            `${name}: workspace dependency ${dependency} must use workspace:*`,
          );
        }
        const target = byName.get(dependency);
        if (target && kind === "app" && target.kind === "app") {
          violations.push(`${name}: app cannot depend on app ${dependency}`);
        }
        if (target && kind === "package" && target.kind === "app") {
          violations.push(
            `${name}: package cannot depend on app ${dependency}`,
          );
        }
      }
    }

    if (
      manifest.dotrelay &&
      typeof manifest.dotrelay === "object" &&
      (manifest.dotrelay as Record<string, unknown>).runtime === "neutral"
    ) {
      for (const file of await sourceFiles(workspace.directory)) {
        const source = await readFile(file, "utf8");
        if (
          /\b(window|document|navigator|Bun)\b|\b(node:|process\.)|from\s+["'](?:node:|(?:fs|path|os|crypto)(?:\/|["']))/.test(
            source,
          )
        ) {
          violations.push(
            `${relative(root, file)}: runtime-neutral package contains browser-only or server-only code`,
          );
        }
      }
    }

    const dependencyNamesForWorkspace = dependencyNames(manifest);
    for (const file of await sourceFiles(workspace.directory)) {
      const source = await readFile(file, "utf8");
      for (const specifier of importedSpecifiers(source)) {
        const target = manifests.find(
          (candidate) =>
            specifier === candidate.name ||
            specifier.startsWith(`${candidate.name}/`),
        );
        if (!target) {
          if (specifier.startsWith("@dotrelay/")) {
            violations.push(
              `${relative(root, file)}: undeclared workspace import ${specifier}`,
            );
          }
          continue;
        }
        if (specifier !== target.name) {
          violations.push(
            `${relative(root, file)}: deep import ${specifier}; use ${target.name}'s public exports`,
          );
        }
        if (!dependencyNamesForWorkspace.has(target.name)) {
          violations.push(
            `${relative(root, file)}: ${target.name} is imported without a declared dependency`,
          );
        }
        if (workspace.kind === "app" && target.kind === "app") {
          violations.push(
            `${relative(root, file)}: app ${workspace.name} cannot import app ${target.name}`,
          );
        }
        if (workspace.kind === "package" && target.kind === "app") {
          violations.push(
            `${relative(root, file)}: package ${workspace.name} cannot import app ${target.name}`,
          );
        }
      }
    }
  }

  violations.push(...cycleDescriptions(graph));
  return [...new Set(violations)].sort();
}

if (import.meta.main) {
  const violations = await validateWorkspaceBoundaries(process.cwd());
  if (violations.length > 0) {
    console.error(violations.map((violation) => `✖ ${violation}`).join("\n"));
    process.exit(1);
  }
  console.log("✓ workspace dependency boundaries are valid");
}
