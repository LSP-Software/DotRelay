import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { validateWorkspaceBoundaries } from "./verify-boundaries";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dotrelay-boundaries-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "apps", "web", "src"), { recursive: true });
  await mkdir(join(root, "apps", "api", "src"), { recursive: true });
  await mkdir(join(root, "packages", "shared", "src"), { recursive: true });
  await mkdir(join(root, "packages", "runtime-neutral", "src"), {
    recursive: true,
  });
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("validateWorkspaceBoundaries", () => {
  test("reports dependency and import boundary violations", async () => {
    const root = await createFixture();

    await writeJson(join(root, "apps", "web", "package.json"), {
      name: "@dotrelay/web",
      private: true,
      dependencies: { "@dotrelay/shared": "workspace:*" },
    });
    await writeJson(join(root, "apps", "api", "package.json"), {
      name: "@dotrelay/api",
      private: true,
    });
    await writeJson(join(root, "packages", "shared", "package.json"), {
      name: "@dotrelay/shared",
      private: true,
    });
    await writeJson(join(root, "packages", "runtime-neutral", "package.json"), {
      name: "@dotrelay/runtime-neutral",
      private: true,
      dotrelay: { runtime: "neutral" },
    });
    await Bun.write(
      join(root, "apps", "web", "src", "index.ts"),
      [
        'import "@dotrelay/api";',
        'import "@dotrelay/shared/src/internal";',
        'import "@dotrelay/undeclared";',
        'import "@dotrelay/runtime-neutral";',
      ].join("\n"),
    );
    await Bun.write(
      join(root, "apps", "api", "src", "index.ts"),
      'import "@dotrelay/web";\n',
    );
    await Bun.write(
      join(root, "packages", "shared", "src", "index.ts"),
      'import "@dotrelay/api";\n',
    );
    await Bun.write(
      join(root, "packages", "runtime-neutral", "src", "index.ts"),
      "const browserOnly = window.location.href;\nvoid browserOnly;\n",
    );

    const violations = await validateWorkspaceBoundaries(root);

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("@dotrelay/api"),
        expect.stringContaining("@dotrelay/shared/src/internal"),
        expect.stringContaining("@dotrelay/undeclared"),
        expect.stringContaining("@dotrelay/web"),
        expect.stringContaining("@dotrelay/runtime-neutral"),
        expect.stringContaining("browser-only"),
      ]),
    );
  });

  test("accepts declared public imports between independent workspaces", async () => {
    const root = await createFixture();

    await writeJson(join(root, "apps", "web", "package.json"), {
      name: "@dotrelay/web",
      private: true,
      dependencies: { "@dotrelay/shared": "workspace:*" },
    });
    await writeJson(join(root, "apps", "api", "package.json"), {
      name: "@dotrelay/api",
      private: true,
    });
    await writeJson(join(root, "packages", "shared", "package.json"), {
      name: "@dotrelay/shared",
      private: true,
      exports: { ".": "./src/index.ts" },
    });
    await writeJson(join(root, "packages", "runtime-neutral", "package.json"), {
      name: "@dotrelay/runtime-neutral",
      private: true,
      dotrelay: { runtime: "neutral" },
      exports: { ".": "./src/index.ts" },
    });
    await Bun.write(
      join(root, "apps", "web", "src", "index.ts"),
      'import "@dotrelay/shared";\n',
    );
    await Bun.write(
      join(root, "apps", "api", "src", "index.ts"),
      "export const api = true;\n",
    );
    await Bun.write(
      join(root, "packages", "shared", "src", "index.ts"),
      "export const shared = true;\n",
    );
    await Bun.write(
      join(root, "packages", "runtime-neutral", "src", "index.ts"),
      "export const neutral = true;\n",
    );

    expect(await validateWorkspaceBoundaries(root)).toEqual([]);
  });
});
