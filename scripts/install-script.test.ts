import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs scripts/install.sh (and install.ps1 where PowerShell is available)
// against a fake GitHub releases server, the way `curl ... | sh` and
// `irm ... | iex` run them.
const installScript = join(import.meta.dir, "install.sh");
const installPowerShell = join(import.meta.dir, "install.ps1");
const shells = [
  ...new Set(["sh", "dash", "bash"].filter((shell) => Bun.which(shell))),
];
const pwsh = Bun.which("pwsh");
const python = Bun.which("python3");
const platform = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";

// Release tag -> asset name -> bytes.
const releases = new Map<string, Map<string, Uint8Array>>();
let latest: string | null = "v1.2.3";
let server: ReturnType<typeof Bun.serve>;
let work: string;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const archiveName = (tag: string): string =>
  `dotrelay-${tag}-${platform}-${arch}.tar.gz`;
const windowsArchiveName = (tag: string): string =>
  `dotrelay-${tag}-win32-x64.zip`;

const run = async (command: readonly string[]): Promise<void> => {
  const child = Bun.spawn([...command], { stderr: "pipe" });
  if ((await child.exited) !== 0)
    throw new Error(
      `${command[0]} failed: ${await new Response(child.stderr).text()}`,
    );
};

// Release archives holding a `dotrelay` script that reports its version,
// packed the way scripts/package-release.py packs them.
const makeRelease = async (
  tag: string,
  options: Readonly<{ corruptSums?: boolean }> = {},
): Promise<void> => {
  const source = await mkdtemp(join(work, "release-"));
  const script = `#!/bin/sh\necho ${tag.slice(1)}\n`;
  await writeFile(join(source, "dotrelay"), script, { mode: 0o755 });
  const assets = new Map<string, Uint8Array>();
  await run([
    "tar",
    "-czf",
    join(source, "archive.tar.gz"),
    "-C",
    source,
    "dotrelay",
  ]);
  assets.set(
    archiveName(tag),
    new Uint8Array(await readFile(join(source, "archive.tar.gz"))),
  );
  if (python !== null) {
    await run([
      python,
      "-I",
      "-c",
      [
        "import sys, zipfile",
        "entry = zipfile.ZipInfo('dotrelay.exe', (1980, 1, 1, 0, 0, 0))",
        "entry.create_system = 3",
        "entry.external_attr = 0o100755 << 16",
        "zipfile.ZipFile(sys.argv[1], 'w').writestr(entry, sys.argv[2])",
      ].join("\n"),
      join(source, "archive.zip"),
      script,
    ]);
    assets.set(
      windowsArchiveName(tag),
      new Uint8Array(await readFile(join(source, "archive.zip"))),
    );
  }
  const sums = [...assets]
    .map(
      ([name, bytes]) =>
        `${options.corruptSums ? sha256(new Uint8Array([1])) : sha256(bytes)}  ${name}\n`,
    )
    .join("");
  assets.set(
    "SHA256SUMS",
    new TextEncoder().encode(
      `${"0".repeat(64)}  release-manifest.json\n${sums}`,
    ),
  );
  releases.set(tag, assets);
};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "dotrelay-install-test-"));
  await makeRelease("v1.2.3");
  await makeRelease("v2.0.0-alpha.1");
  await makeRelease("v6.6.6", { corruptSums: true });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/releases/latest")
        return new Response(null, {
          status: 302,
          headers: {
            Location: latest === null ? "/releases" : `/releases/tag/${latest}`,
          },
        });
      if (pathname === "/releases" || pathname.startsWith("/releases/tag/"))
        return new Response("release page");
      const match = /^\/releases\/download\/([^/]+)\/([^/]+)$/.exec(pathname);
      const asset = releases.get(match?.[1] ?? "")?.get(match?.[2] ?? "");
      return asset
        ? new Response(asset)
        : new Response("not found", { status: 404 });
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await rm(work, { recursive: true, force: true });
});

const install = async (
  shell: string,
  env: Record<string, string> = {},
): Promise<
  Readonly<{
    stdout: string;
    stderr: string;
    exitCode: number;
    installDir: string;
    temp: string;
  }>
> => {
  const home = await mkdtemp(join(work, "home-"));
  const temp = join(home, "tmp");
  await mkdir(temp);
  const installDir = join(home, "bin");
  // Piped into the shell, as the documented curl command does.
  const child = Bun.spawn([shell], {
    stdin: await readFile(installScript),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: temp,
      DOTRELAY_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}/releases`,
      DOTRELAY_INSTALL_DIR: installDir,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode, installDir, temp };
};

const installed = async (installDir: string): Promise<string> => {
  const child = Bun.spawn([join(installDir, "dotrelay")], { stdout: "pipe" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return output.trim();
};

describe.skipIf(process.platform === "win32")("install.sh", () => {
  for (const shell of shells) {
    test(`${shell}: installs the latest stable release after verifying it`, async () => {
      latest = "v1.2.3";
      const result = await install(shell);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `dotrelay v1.2.3 for ${platform}-${arch}`,
      );
      expect(result.stdout).toContain("verified SHA-256");
      expect(result.stdout).toContain("is not on your PATH");
      expect(await installed(result.installDir)).toBe("1.2.3");
      expect(await readdir(result.temp)).toEqual([]);
    });
  }

  test("installs a pinned version and skips PATH advice when it is on PATH", async () => {
    const home = await mkdtemp(join(work, "pinned-"));
    const installDir = join(home, "bin");
    const result = await install("sh", {
      DOTRELAY_VERSION: "2.0.0-alpha.1",
      DOTRELAY_INSTALL_DIR: installDir,
      PATH: `${installDir}:${process.env.PATH ?? ""}`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("is not on your PATH");
    expect(await installed(installDir)).toBe("2.0.0-alpha.1");
  });

  test("replaces an existing install", async () => {
    const first = await install("sh", { DOTRELAY_VERSION: "v1.2.3" });
    expect(first.exitCode).toBe(0);
    const second = await install("sh", {
      DOTRELAY_VERSION: "v2.0.0-alpha.1",
      DOTRELAY_INSTALL_DIR: first.installDir,
    });
    expect(second.exitCode).toBe(0);
    expect(await installed(first.installDir)).toBe("2.0.0-alpha.1");
    expect(await readdir(first.installDir)).toEqual(["dotrelay"]);
  });

  test("aborts on a checksum mismatch without installing", async () => {
    const result = await install("sh", { DOTRELAY_VERSION: "v6.6.6" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(result.stderr).toContain("Nothing was installed");
    expect(
      await readdir(result.installDir).catch(() => [] as string[]),
    ).toEqual([]);
    expect(await readdir(result.temp)).toEqual([]);
  });

  test("names DOTRELAY_VERSION when there is no stable release", async () => {
    latest = null;
    const result = await install("sh");
    latest = "v1.2.3";
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("found no stable release");
    expect(result.stderr).toContain("DOTRELAY_VERSION");
  });

  test("fails loudly for a missing release", async () => {
    const result = await install("sh", { DOTRELAY_VERSION: "9.9.9" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("download failed");
    expect(result.stderr).toContain("/download/v9.9.9/");
  });

  test("rejects a malformed DOTRELAY_VERSION", async () => {
    const result = await install("sh", {
      DOTRELAY_VERSION: "latest; rm -rf /",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "DOTRELAY_VERSION must be a release version",
    );
  });
});

// The PowerShell script targets Windows; on Linux and macOS it runs with the
// Windows environment variables it reads faked.
describe.skipIf(pwsh === null || python === null)("install.ps1", () => {
  const installWithPowerShell = async (env: Record<string, string>) => {
    const home = await mkdtemp(join(work, "pwsh-"));
    const installDir = join(home, "bin");
    const temp = join(home, "tmp");
    await mkdir(temp);
    const child = Bun.spawn(
      [
        pwsh ?? "pwsh",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `try { Get-Content -Raw -LiteralPath '${installPowerShell}' | Invoke-Expression } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TMPDIR: `${temp}/`,
          OS: "Windows_NT",
          PROCESSOR_ARCHITECTURE: "AMD64",
          DOTRELAY_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}/releases`,
          DOTRELAY_INSTALL_DIR: installDir,
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode, installDir, temp };
  };

  test("installs the latest stable release after verifying it", async () => {
    latest = "v1.2.3";
    const result = await installWithPowerShell({});
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("verified SHA-256");
    expect(result.stdout).toContain("installed dotrelay 1.2.3");
    expect(await readdir(result.installDir)).toEqual(["dotrelay.exe"]);
    expect(await readdir(result.temp)).toEqual([]);
  }, 30_000);

  test("aborts on a checksum mismatch without installing", async () => {
    const result = await installWithPowerShell({ DOTRELAY_VERSION: "6.6.6" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(
      await readdir(result.installDir).catch(() => [] as string[]),
    ).toEqual([]);
    expect(await readdir(result.temp)).toEqual([]);
  }, 30_000);
});
