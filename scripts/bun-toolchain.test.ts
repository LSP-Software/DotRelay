import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Asset = Readonly<{
  name: string;
  version: string;
  url: string;
  integrity: string;
}>;
type Toolchain = Readonly<{
  revision: string;
  commit: string;
  assets: readonly Asset[];
}>;

const root = join(import.meta.dir, "..");
const read = (path: string) => Bun.file(join(root, path)).text();
const lock = JSON.parse(await read("ops/bun-toolchain.json")) as Toolchain & {
  readonly lint: Toolchain;
};
const runtimeVersion = lock.revision.slice(0, lock.revision.indexOf("+"));

// Everything that runs DotRelay (the API image, the web build, the compiled
// CLI, the test suites) uses one stable Bun release. The canary build is kept
// only because `bun lint` is not in stable releases yet.
describe("pinned Bun toolchains", () => {
  test("the runtime toolchain is a stable release", () => {
    expect(lock.revision).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{9}$/);
    expect(lock.revision).not.toContain("canary");
    expect(lock.commit.startsWith(lock.revision.split("+")[1] ?? "-")).toBe(
      true,
    );
    for (const asset of lock.assets) {
      expect(asset.version).toBe(runtimeVersion);
      expect(asset.url).toStartWith("https://registry.npmjs.org/@oven/");
      expect(asset.integrity).toStartWith("sha512-");
    }
    expect(lock.assets.map((asset) => asset.name).sort()).toEqual([
      "@oven/bun-darwin-aarch64",
      "@oven/bun-darwin-x64",
      "@oven/bun-linux-aarch64",
      "@oven/bun-linux-x64",
      "@oven/bun-windows-x64",
    ]);
  });

  test("the canary is a separate lint-only toolchain", async () => {
    expect(lock.lint.revision).toContain("canary");
    expect(lock.lint.commit).not.toBe(lock.commit);
    expect(await read("scripts/lint.ts")).toContain("lint");
  });

  test("the API and web images build and run on the runtime toolchain", async () => {
    for (const path of ["apps/api/Dockerfile", "apps/web/Dockerfile"]) {
      const dockerfile = await read(path);
      expect(dockerfile).not.toContain("canary");
      expect(dockerfile).toContain(`"$(bun --revision)" = "${lock.revision}"`);
      expect(dockerfile).toContain(`oven/bun:${runtimeVersion}@sha256:`);
    }
  });

  test("hosted builds, the package manager pin and the runtime matrix agree", async () => {
    const railpack = JSON.parse(await read("railpack.json")) as {
      packages: { bun: string };
    };
    expect(railpack.packages.bun).toBe(runtimeVersion);
    const manifest = JSON.parse(await read("package.json")) as {
      packageManager: string;
    };
    expect(manifest.packageManager).toBe(`bun@${runtimeVersion}`);
    expect(await read("docs/wiki/crypto.md")).toContain(
      `Bun \`${runtimeVersion}\``,
    );
  });
});
