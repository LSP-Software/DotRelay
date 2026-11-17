import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors";
import { run } from "./index";
import {
  CHECK_INTERVAL_MS,
  channelFor,
  compareVersions,
  detectInstallation,
  isNewerVersion,
  targetVersion,
  startUpdateCheck,
  updateCheckPath,
  updateCli,
  updateNoticeAllowed,
} from "./update";

const distTags = (tags: Record<string, string>) => {
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json(tags);
  };
  return { fetch: fetcher as typeof fetch, calls };
};

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dotrelay-update-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("versions", () => {
  test("orders releases and prereleases by semantic version precedence", () => {
    const ordered = [
      "0.1.0-alpha.1",
      "0.1.0-alpha.2",
      "0.1.0-alpha.10",
      "0.1.0-beta",
      "0.1.0-rc.1",
      "0.1.0",
      "0.1.1",
      "0.2.0",
      "1.0.0",
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(
        compareVersions(ordered[index - 1] ?? "", ordered[index] ?? ""),
      ).toBe(-1);
      expect(
        compareVersions(ordered[index] ?? "", ordered[index - 1] ?? ""),
      ).toBe(1);
    }
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
  });

  test("names the channel a version follows", () => {
    expect(channelFor("1.2.3")).toBe("latest");
    expect(channelFor("0.1.0-alpha.3")).toBe("alpha");
    expect(channelFor("2.0.0-rc.1")).toBe("rc");
    expect(channelFor("0.0.0-dev.abc123")).toBe("dev");
    expect(channelFor("0.0.0-foundation")).toBeNull();
  });

  test("a dev build is behind any other dev version", () => {
    expect(isNewerVersion("0.0.0-dev.aaa", "0.0.0-dev.bbb")).toBe(true);
    expect(isNewerVersion("0.0.0-dev.aaa", "0.0.0-dev.aaa")).toBe(false);
    expect(isNewerVersion("1.0.0", "0.9.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "not-a-version")).toBe(false);
  });
});

describe("tracks", () => {
  test("each build stays on the track it was installed from", () => {
    const tags = {
      latest: "1.0.0",
      alpha: "1.1.0-alpha.2",
      dev: "0.0.0-dev.new",
    };
    expect(targetVersion("latest", tags)).toBe("1.0.0");
    expect(targetVersion("alpha", tags)).toBe("1.1.0-alpha.2");
    expect(targetVersion("dev", tags)).toBe("0.0.0-dev.new");
  });

  test("a prerelease moves on to latest when that is newer or its tag is missing", () => {
    // Before the first stable release, prereleases are published as latest.
    expect(targetVersion("alpha", { latest: "0.2.0-alpha.1" })).toBe(
      "0.2.0-alpha.1",
    );
    // Once its release is out, an alpha user is offered it.
    expect(
      targetVersion("alpha", { latest: "1.1.0", alpha: "1.1.0-alpha.2" }),
    ).toBe("1.1.0");
  });

  test("dev and release builds never cross over", () => {
    expect(targetVersion("latest", { latest: "0.0.0-dev.x" })).toBeNull();
    expect(targetVersion("dev", { dev: "1.0.0" })).toBeNull();
    expect(isNewerVersion("1.0.0", "0.0.0-dev.x")).toBe(false);
    expect(isNewerVersion("0.0.0-dev.x", "1.0.0")).toBe(false);
  });
});

describe("background check", () => {
  test("asks the registry once a day and reuses the answer in between", async () => {
    const registry = distTags({ latest: "1.1.0", dev: "0.0.0-dev.x" });
    let now = 1_000_000;
    const options = {
      version: "1.0.0",
      stateDirectory: directory,
      fetch: registry.fetch,
      now: () => now,
    };
    expect(await startUpdateCheck(options)).toBe("1.1.0");
    expect(registry.calls).toEqual([
      "https://registry.npmjs.org/-/package/@dotrelay/cli/dist-tags",
    ]);
    now += CHECK_INTERVAL_MS - 1;
    expect(await startUpdateCheck(options)).toBe("1.1.0");
    expect(registry.calls).toHaveLength(1);
    now += 1;
    expect(await startUpdateCheck(options)).toBe("1.1.0");
    expect(registry.calls).toHaveLength(2);
  });

  test("follows the dev tag for a dev build", async () => {
    const registry = distTags({ latest: "1.1.0", dev: "0.0.0-dev.new" });
    expect(
      await startUpdateCheck({
        version: "0.0.0-dev.old",
        stateDirectory: directory,
        fetch: registry.fetch,
      }),
    ).toBe("0.0.0-dev.new");
  });

  test("says nothing when up to date, from source, or offline", async () => {
    const registry = distTags({ latest: "1.0.0" });
    expect(
      await startUpdateCheck({
        version: "1.0.0",
        stateDirectory: directory,
        fetch: registry.fetch,
      }),
    ).toBeNull();
    expect(
      await startUpdateCheck({
        version: "0.0.0-foundation",
        stateDirectory: join(directory, "source"),
        fetch: registry.fetch,
      }),
    ).toBeNull();
    const offline = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(
      await startUpdateCheck({
        version: "1.0.0",
        stateDirectory: join(directory, "offline"),
        fetch: offline,
      }),
    ).toBeNull();
    // The failed check is remembered, so the next run doesn't wait again.
    const cached = JSON.parse(
      await readFile(updateCheckPath(join(directory, "offline")), "utf8"),
    );
    expect(cached.channel).toBe("latest");
    expect(cached.latest).toBeUndefined();
  });

  test("keeps announcing a known release while the registry is unreachable", async () => {
    let now = 0;
    await startUpdateCheck({
      version: "1.0.0",
      stateDirectory: directory,
      fetch: distTags({ latest: "1.2.0" }).fetch,
      now: () => now,
    });
    now += CHECK_INTERVAL_MS;
    const offline = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(
      await startUpdateCheck({
        version: "1.0.0",
        stateDirectory: directory,
        fetch: offline,
        now: () => now,
      }),
    ).toBe("1.2.0");
  });

  test("only shows the notice to a person at a terminal", () => {
    const env = {};
    expect(updateNoticeAllowed(["status"], env, true)).toBe(true);
    expect(updateNoticeAllowed(["status"], env, false)).toBe(false);
    expect(updateNoticeAllowed(["status"], { CI: "true" }, true)).toBe(false);
    expect(
      updateNoticeAllowed(["status"], { DOTRELAY_NO_UPDATE_CHECK: "1" }, true),
    ).toBe(false);
    expect(
      updateNoticeAllowed(["status"], { DOTRELAY_NO_UPDATE_CHECK: "0" }, true),
    ).toBe(true);
    expect(updateNoticeAllowed(["status", "--json"], env, true)).toBe(false);
    expect(updateNoticeAllowed(["pull", "--no-input"], env, true)).toBe(false);
    expect(updateNoticeAllowed(["--version"], env, true)).toBe(false);
    expect(updateNoticeAllowed(["update"], env, true)).toBe(false);
    expect(updateNoticeAllowed(["run", "--", "node", "x"], env, true)).toBe(
      false,
    );
    // Flags after -- belong to the wrapped program, not to dotrelay.
    expect(updateNoticeAllowed(["push", "--", "--json"], env, true)).toBe(true);
  });
});

describe("installation", () => {
  const globalRoot = "/usr/lib/node_modules";
  const npmRoot = {
    which: (command: string) => (command === "npm" ? "/usr/bin/npm" : null),
    capture: async () => ({ exitCode: 0, stdout: `${globalRoot}\n` }),
  };

  test("recognises npm, bun, project, standalone, and source copies", async () => {
    const npmBinary = `${globalRoot}/@dotrelay/cli-linux-x64/bin/dotrelay`;
    expect(
      await detectInstallation("1.0.0", { ...npmRoot, execPath: npmBinary }),
    ).toEqual({ kind: "package", manager: "npm", path: npmBinary });
    const bunBinary =
      "/home/me/.bun/install/global/node_modules/@dotrelay/cli-linux-x64/bin/dotrelay";
    expect(
      await detectInstallation("1.0.0", { ...npmRoot, execPath: bunBinary }),
    ).toEqual({ kind: "package", manager: "bun", path: bunBinary });
    const projectBinary =
      "/work/app/node_modules/@dotrelay/cli-linux-x64/bin/dotrelay";
    expect(
      await detectInstallation("1.0.0", {
        ...npmRoot,
        execPath: projectBinary,
      }),
    ).toEqual({ kind: "package", manager: null, path: projectBinary });
    expect(
      await detectInstallation("1.0.0", {
        ...npmRoot,
        execPath: "/home/me/.local/bin/dotrelay",
      }),
    ).toEqual({ kind: "standalone", path: "/home/me/.local/bin/dotrelay" });
    expect(await detectInstallation("0.0.0-foundation")).toEqual({
      kind: "source",
    });
  });

  test("updates a global npm copy with npm", async () => {
    const attached: (readonly string[])[] = [];
    const result = await updateCli("1.0.0", {
      ...npmRoot,
      fetch: distTags({ latest: "1.1.0" }).fetch,
      execPath: `${globalRoot}/@dotrelay/cli-linux-x64/bin/dotrelay`,
      attach: async (command) => {
        attached.push(command);
        return 0;
      },
    });
    expect(attached).toEqual([
      ["/usr/bin/npm", "install", "--global", "@dotrelay/cli@1.1.0"],
    ]);
    expect(result).toMatchObject({
      updated: true,
      previousVersion: "1.0.0",
      version: "1.1.0",
      installation: "package",
    });
  });

  test("updates a global bun copy with bun", async () => {
    const attached: (readonly string[])[] = [];
    await updateCli("0.0.0-dev.old", {
      which: (command) => `/bin/${command}`,
      fetch: distTags({ dev: "0.0.0-dev.new" }).fetch,
      execPath:
        "/home/me/.bun/install/global/node_modules/@dotrelay/cli-linux-x64/bin/dotrelay",
      attach: async (command) => {
        attached.push(command);
        return 0;
      },
    });
    expect(attached).toEqual([
      ["/bin/bun", "add", "--global", "@dotrelay/cli@0.0.0-dev.new"],
    ]);
  });

  test("reports a failed package manager run", async () => {
    await expect(
      updateCli("1.0.0", {
        ...npmRoot,
        fetch: distTags({ latest: "1.1.0" }).fetch,
        execPath: `${globalRoot}/@dotrelay/cli-linux-x64/bin/dotrelay`,
        attach: async () => 243,
      }),
    ).rejects.toThrow("npm couldn't install @dotrelay/cli@1.1.0");
  });

  test("leaves a project's copy to the project", async () => {
    await expect(
      updateCli("1.0.0", {
        ...npmRoot,
        fetch: distTags({ latest: "1.1.0" }).fetch,
        execPath: "/work/app/node_modules/@dotrelay/cli-linux-x64/bin/dotrelay",
        attach: async () => {
          throw new Error("must not run");
        },
      }),
    ).rejects.toThrow("npm install @dotrelay/cli@1.1.0");
  });

  test("does nothing when already on the newest version", async () => {
    const result = await updateCli("1.1.0", {
      ...npmRoot,
      fetch: distTags({ latest: "1.1.0" }).fetch,
      execPath: "/home/me/.local/bin/dotrelay",
    });
    expect(result).toMatchObject({ updated: false, version: "1.1.0" });
  });

  test("refuses to update a source build", async () => {
    await expect(updateCli("0.0.0-foundation")).rejects.toBeInstanceOf(
      CliError,
    );
  });
});

describe.skipIf(process.platform === "win32")("standalone binary", () => {
  // A release archive whose "binary" is a script printing its version.
  const release = async (latest: string) => {
    const source = join(directory, "release");
    await mkdir(source);
    await writeFile(join(source, "dotrelay"), `#!/bin/sh\necho ${latest}\n`, {
      mode: 0o755,
    });
    const archiveName = `dotrelay-v${latest}-linux-x64.tar.gz`;
    const archivePath = join(directory, archiveName);
    const tar = Bun.spawnSync([
      "tar",
      "-czf",
      archivePath,
      "-C",
      source,
      "dotrelay",
    ]);
    expect(tar.exitCode).toBe(0);
    const archive = await readFile(archivePath);
    const sum = createHash("sha256").update(archive).digest("hex");
    return { archiveName, archive, sum };
  };

  const installed = async () => {
    const binDirectory = join(directory, "bin");
    await mkdir(binDirectory);
    const path = join(binDirectory, "dotrelay");
    await writeFile(path, "#!/bin/sh\necho 1.0.0\n");
    await chmod(path, 0o755);
    return path;
  };

  const releaseFetch = (
    files: Record<string, Uint8Array | string>,
  ): { fetch: typeof fetch; calls: string[] } => {
    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/dist-tags")) return Response.json({ latest: "1.1.0" });
      const name = url.slice(url.lastIndexOf("/") + 1);
      const body = files[name];
      return body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body);
    };
    return { fetch: fetcher as typeof fetch, calls };
  };

  const standalone = (path: string, fetcher: typeof fetch) => ({
    execPath: path,
    platform: "linux" as const,
    arch: "x64",
    fetch: fetcher,
    which: () => null,
    environment: {
      DOTRELAY_DOWNLOAD_BASE: "https://releases.example/DotRelay/releases/",
    },
  });

  test("replaces the binary with the checksum-verified release", async () => {
    const { archiveName, archive, sum } = await release("1.1.0");
    const path = await installed();
    const registry = releaseFetch({
      [archiveName]: archive,
      SHA256SUMS: `${sum}  ${archiveName}\n`,
    });
    const result = await updateCli("1.0.0", standalone(path, registry.fetch));
    expect(result).toMatchObject({ updated: true, installation: "standalone" });
    expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho 1.1.0\n");
    expect(registry.calls).toContain(
      `https://releases.example/DotRelay/releases/download/v1.1.0/${archiveName}`,
    );
  });

  test("keeps the old binary when the checksum doesn't match", async () => {
    const { archiveName, archive } = await release("1.1.0");
    const path = await installed();
    const registry = releaseFetch({
      [archiveName]: archive,
      SHA256SUMS: `${"0".repeat(64)}  ${archiveName}\n`,
    });
    await expect(
      updateCli("1.0.0", standalone(path, registry.fetch)),
    ).rejects.toThrow("doesn't match its published checksum");
    expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho 1.0.0\n");
  });

  test("keeps the old binary when the new one reports another version", async () => {
    const { archiveName, archive, sum } = await release("1.0.5");
    const path = await installed();
    const registry = releaseFetch({
      [archiveName.replace("1.0.5", "1.1.0")]: archive,
      SHA256SUMS: `${sum}  ${archiveName.replace("1.0.5", "1.1.0")}\n`,
    });
    await expect(
      updateCli("1.0.0", standalone(path, registry.fetch)),
    ).rejects.toThrow("doesn't run on this machine");
    expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho 1.0.0\n");
  });
});

describe("dotrelay update", () => {
  test("rejects arguments and unsupported flags", async () => {
    const extra = await run(["update", "now"], { stdoutIsTerminal: false });
    expect(extra.exitCode).toBe(2);
    const profile = await run(["update", "--profile", "work"], {
      stdoutIsTerminal: false,
    });
    expect(profile.exitCode).toBe(2);
  });

  test("reports the result as JSON", async () => {
    const result = await run(["update", "--json"], {
      stdoutIsTerminal: false,
      profilePath: join(directory, "profiles.json"),
      update: {
        fetch: distTags({ latest: "1.0.0" }).fetch,
        execPath: "/home/me/.local/bin/dotrelay",
        which: () => null,
      },
    });
    // A source build can't update itself, and says how to get a release.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("built from source");
  });
});
