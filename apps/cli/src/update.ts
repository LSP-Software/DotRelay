import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { CliError } from "./errors";
import type { FetchFunction } from "./profile";

// Every release, stable, prerelease or dev, is published to npm under a
// dist-tag, so the registry answers "what is the newest dotrelay" on each
// track without calling the GitHub API (ADR 0005).
export const PACKAGE_NAME = "@dotrelay/cli";
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
const RELEASES_URL = "https://github.com/LSP-Software/DotRelay/releases";

/** How long a successful or failed check is reused before asking again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A background check never holds a finished command longer than this. */
export const CHECK_DEADLINE_MS = 2_000;

/** The npm dist-tag a build follows: latest, dev, or a prerelease's own. */
export type ReleaseChannel = string;

const isDevVersion = (version: string): boolean =>
  version.startsWith("0.0.0-dev.");

// Each build stays on the track it was installed from (scripts/publish-cli.ts
// names the tags): dev builds from main are versioned 0.0.0-dev.<commit-sha>
// and follow "dev"; a prerelease such as 1.2.0-alpha.3 follows the tag named
// by its first identifier ("alpha"); a stable release follows "latest". A
// source run reports 0.0.0-foundation and has no channel.
export const channelFor = (version: string): ReleaseChannel | null => {
  if (isDevVersion(version)) return "dev";
  const parsed = parseVersion(version);
  if (!parsed || version === "0.0.0-foundation") return null;
  const identifier = parsed.prerelease[0];
  return identifier &&
    /^[A-Za-z]+$/u.test(identifier) &&
    identifier !== "latest"
    ? identifier
    : "latest";
};

type ParsedVersion = Readonly<{
  core: readonly [number, number, number];
  prerelease: readonly string[];
}>;

const parseVersion = (value: string): ParsedVersion | null => {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      value,
    );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
};

// Semantic Versioning 2.0 precedence: the core first, then a prerelease
// sorts before its release, and prerelease identifiers compare one by one.
export const compareVersions = (left: string, right: string): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Not a version: ${a ? right : left}`);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return Math.sign(b.prerelease.length - a.prerelease.length);
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
};

/**
 * Whether `candidate` should replace `current`. Dev versions carry a commit
 * sha rather than an order, and the dev tag only moves forward, so any other
 * dev version is newer.
 */
export const isNewerVersion = (current: string, candidate: string): boolean => {
  // Dev and release builds never cross over, whatever a tag says.
  if (isDevVersion(current) !== isDevVersion(candidate)) return false;
  if (isDevVersion(current)) return candidate !== current;
  if (!parseVersion(candidate)) return false;
  return compareVersions(candidate, current) > 0;
};

/**
 * The version a build on `channel` should move to, from the npm dist-tags.
 * A prerelease track also considers "latest": until the first stable release
 * prereleases are published there, and once its stable release is out an
 * alpha user moves on to it. Null when no tag offers a usable version.
 */
export const targetVersion = (
  channel: ReleaseChannel,
  tags: Readonly<Record<string, unknown>>,
): string | null => {
  const tagNames =
    channel === "dev" || channel === "latest" ? [channel] : [channel, "latest"];
  const candidates = tagNames
    .map((name) => tags[name])
    .filter(
      (value): value is string =>
        typeof value === "string" &&
        parseVersion(value) !== null &&
        isDevVersion(value) === (channel === "dev"),
    );
  if (channel === "dev") return candidates[0] ?? null;
  return candidates.reduce<string | null>(
    (best, value) =>
      best === null || compareVersions(value, best) > 0 ? value : best,
    null,
  );
};

/** Reads the version a build on the channel should move to. */
export const fetchPublishedVersion = async (
  channel: ReleaseChannel,
  options: Readonly<{ fetch?: FetchFunction; deadlineMs?: number }> = {},
): Promise<string> => {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(DIST_TAGS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(options.deadlineMs ?? 10_000),
  });
  if (!response.ok)
    throw new Error(`The npm registry answered HTTP ${response.status}.`);
  const tags = (await response.json()) as Record<string, unknown>;
  const published = targetVersion(channel, tags);
  if (!published)
    throw new Error(`The npm registry has no ${channel} version.`);
  return published;
};

type CachedCheck = Readonly<{
  checkedAt: number;
  channel: ReleaseChannel;
  latest?: string;
}>;

export const updateCheckPath = (stateDirectory: string): string =>
  join(stateDirectory, "update-check.json");

const readCachedCheck = async (path: string): Promise<CachedCheck | null> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as CachedCheck;
    if (typeof value.checkedAt !== "number") return null;
    if (typeof value.channel !== "string") return null;
    if (value.latest !== undefined && !parseVersion(value.latest)) return null;
    return value;
  } catch {
    return null;
  }
};

const writeCachedCheck = async (
  path: string,
  value: CachedCheck,
): Promise<void> => {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch {
    // The check is advisory; a read-only state directory only means the
    // registry is asked again next time.
  }
};

export type UpdateCheckOptions = Readonly<{
  version: string;
  stateDirectory: string;
  fetch?: FetchFunction;
  now?: () => number;
  deadlineMs?: number;
}>;

/**
 * Starts the once-a-day check for a newer release. The registry is asked at
 * most once per CHECK_INTERVAL_MS, in the background while the command runs;
 * failures are remembered as checks too so an offline machine is not slowed
 * down on every run. Resolves to the newer version, or null.
 */
export const startUpdateCheck = (
  options: UpdateCheckOptions,
): Promise<string | null> => {
  const channel = channelFor(options.version);
  if (!channel) return Promise.resolve(null);
  const now = options.now ?? Date.now;
  const path = updateCheckPath(options.stateDirectory);
  const newer = (latest: string | undefined): string | null =>
    latest !== undefined && isNewerVersion(options.version, latest)
      ? latest
      : null;
  return (async () => {
    const cached = await readCachedCheck(path);
    const age = cached ? now() - cached.checkedAt : Number.POSITIVE_INFINITY;
    if (
      cached &&
      cached.channel === channel &&
      age >= 0 &&
      age < CHECK_INTERVAL_MS
    )
      return newer(cached.latest);
    try {
      const latest = await fetchPublishedVersion(channel, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        deadlineMs: options.deadlineMs ?? CHECK_DEADLINE_MS,
      });
      await writeCachedCheck(path, { checkedAt: now(), channel, latest });
      return newer(latest);
    } catch {
      // Keep the last known answer, so a release seen yesterday is still
      // announced while the registry is unreachable today.
      const latest = cached?.channel === channel ? cached.latest : undefined;
      await writeCachedCheck(path, {
        checkedAt: now(),
        channel,
        ...(latest ? { latest } : {}),
      });
      return newer(latest);
    }
  })().catch(() => null);
};

/** Stops waiting for a check after `deadlineMs`, answering null. */
export const settleWithin = <T>(
  pending: Promise<T | null>,
  deadlineMs: number,
): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Whether this run may print the update notice: someone is reading stderr,
 * the output isn't for a script, and the user hasn't turned the check off.
 */
export const updateNoticeAllowed = (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  stderrIsTerminal: boolean,
): boolean => {
  if (!stderrIsTerminal) return false;
  if (environment.CI !== undefined) return false;
  const optOut = environment.DOTRELAY_NO_UPDATE_CHECK;
  if (optOut !== undefined && optOut !== "" && optOut !== "0") return false;
  const separator = args.indexOf("--");
  const own = separator < 0 ? args : args.slice(0, separator);
  if (
    own.some((arg) => ["--json", "--no-input", "--version", "-v"].includes(arg))
  )
    return false;
  // `run` hands the terminal to another program, and `update` reports the
  // version itself.
  const command = own.find((arg) => !arg.startsWith("-"));
  return command !== "run" && command !== "update";
};

// ---------------------------------------------------------------------------
// Installing an update

export type Installation =
  | Readonly<{ kind: "source" }>
  | Readonly<{
      kind: "package";
      /** The package manager that owns a global install, when known. */
      manager: "npm" | "bun" | null;
      path: string;
    }>
  | Readonly<{ kind: "standalone"; path: string }>;

export type CommandResult = Readonly<{ exitCode: number; stdout: string }>;

export type UpdateDependencies = Readonly<{
  fetch?: FetchFunction;
  /** The running binary. Defaults to process.execPath. */
  execPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  environment?: NodeJS.ProcessEnv;
  /** Finds an executable on PATH. */
  which?: (command: string) => string | null;
  /** Runs a command with its output captured. */
  capture?: (command: readonly string[]) => Promise<CommandResult>;
  /** Runs a command attached to the terminal; resolves to its exit code. */
  attach?: (command: readonly string[]) => Promise<number>;
  /** Called before each step so the user sees progress. */
  progress?: (step: string) => void;
}>;

const defaultCapture = async (
  command: readonly string[],
): Promise<CommandResult> => {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { exitCode, stdout };
};

const defaultAttach = async (command: readonly string[]): Promise<number> => {
  // The package manager's own output goes to stderr, like the rest of the
  // CLI's progress, so stdout stays clean for --json.
  const child = Bun.spawn([...command], {
    stdin: "inherit",
    stdout: 2,
    stderr: "inherit",
  });
  return child.exited;
};

const containsSegment = (path: string, segments: readonly string[]): boolean =>
  path.includes(`${sep}${segments.join(sep)}${sep}`) ||
  path.includes(`/${segments.join("/")}/`);

/**
 * Works out how the running binary was installed: from an npm platform
 * package (globally by npm or bun, or inside a project), as a standalone
 * binary from a GitHub release, or built from source.
 */
export const detectInstallation = async (
  version: string,
  dependencies: UpdateDependencies = {},
): Promise<Installation> => {
  if (!channelFor(version)) return { kind: "source" };
  const execPath = dependencies.execPath ?? process.execPath;
  const path = await realpath(execPath).catch(() => execPath);
  if (
    !/[/\\]node_modules[/\\]@dotrelay[/\\]cli-[^/\\]+[/\\]bin[/\\]/u.test(path)
  )
    return { kind: "standalone", path };
  if (containsSegment(path, [".bun", "install", "global", "node_modules"]))
    return { kind: "package", manager: "bun", path };
  const which = dependencies.which ?? Bun.which;
  const npm = which("npm");
  if (npm) {
    const capture = dependencies.capture ?? defaultCapture;
    const root = await capture([npm, "root", "-g"]).catch(() => null);
    const globalRoot = root?.exitCode === 0 ? root.stdout.trim() : "";
    if (globalRoot) {
      const resolvedRoot = await realpath(globalRoot).catch(() => globalRoot);
      if (
        path.startsWith(`${resolvedRoot}${sep}`) ||
        path.startsWith(`${resolvedRoot}/`)
      )
        return { kind: "package", manager: "npm", path };
    }
  }
  return { kind: "package", manager: null, path };
};

const releaseTarget = (
  platform: NodeJS.Platform,
  arch: string,
): Readonly<{ target: string; archive: "tar.gz" | "zip" }> | null => {
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
    return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  return {
    target: `${platform}-${arch}`,
    archive: platform === "win32" ? "zip" : "tar.gz",
  };
};

const download = async (
  fetcher: FetchFunction,
  url: string,
): Promise<Uint8Array> => {
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new CliError(
      "transient",
      `Couldn't download ${url}. Check your connection and run dotrelay update again.`,
    );
  }
  if (!response.ok)
    throw new CliError(
      "transient",
      `Couldn't download ${url} (HTTP ${response.status}). Run dotrelay update again later.`,
    );
  return new Uint8Array(await response.arrayBuffer());
};

const installFailure = (path: string, reason: string): CliError =>
  new CliError(
    "local-io",
    `Couldn't replace ${path}: ${reason}. Nothing was changed. If you can't write there, reinstall with the install script.`,
  );

// Downloads the release archive, checks it against the release's SHA256SUMS
// (as the install scripts do), extracts the binary, makes sure it runs and
// reports the expected version, then swaps it in with a rename so the
// running file is never overwritten in place.
const replaceStandaloneBinary = async (
  path: string,
  latest: string,
  dependencies: UpdateDependencies,
): Promise<void> => {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const target = releaseTarget(platform, arch);
  if (!target)
    throw new CliError(
      "invocation",
      `DotRelay doesn't publish a binary for ${platform}-${arch}. See ${RELEASES_URL}.`,
    );
  const environment = dependencies.environment ?? process.env;
  const base = (environment.DOTRELAY_DOWNLOAD_BASE ?? RELEASES_URL).replace(
    /\/+$/u,
    "",
  );
  const tag = `v${latest}`;
  const archiveName = `dotrelay-${tag}-${target.target}.${target.archive}`;
  const fetcher = dependencies.fetch ?? fetch;
  const progress = dependencies.progress ?? (() => {});

  progress(`Downloading dotrelay ${latest} for ${target.target}`);
  const [archive, sums] = await Promise.all([
    download(fetcher, `${base}/download/${tag}/${archiveName}`),
    download(fetcher, `${base}/download/${tag}/SHA256SUMS`),
  ]);
  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find(
      ([, name]) => name === archiveName || name === `*${archiveName}`,
    )?.[0];
  if (!expected || !/^[0-9a-f]{64}$/u.test(expected))
    throw new CliError(
      "crypto",
      `The SHA256SUMS for ${tag} has no checksum for ${archiveName}. Nothing was installed.`,
    );
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected)
    throw new CliError(
      "crypto",
      `The download of ${archiveName} doesn't match its published checksum. Nothing was installed.`,
    );
  progress(`Verified SHA-256 ${actual}`);

  const binaryName = platform === "win32" ? "dotrelay.exe" : "dotrelay";
  const workspace = await mkdtemp(join(tmpdir(), "dotrelay-update-"));
  const directory = dirname(path);
  // Windows runs only files that end in .exe.
  const staged = join(
    directory,
    `.dotrelay.update.${process.pid}${platform === "win32" ? ".exe" : ""}`,
  );
  try {
    const archivePath = join(workspace, archiveName);
    await writeFile(archivePath, archive);
    const extractDirectory = join(workspace, "extract");
    await mkdir(extractDirectory);
    const capture = dependencies.capture ?? defaultCapture;
    // tar ships with macOS, Linux, and Windows 10 and later, where it also
    // reads zip archives.
    const extracted = await capture([
      "tar",
      "-xf",
      archivePath,
      "-C",
      extractDirectory,
    ]).catch(() => ({ exitCode: 1, stdout: "" }));
    const binary = join(extractDirectory, binaryName);
    const info = await lstat(binary).catch(() => null);
    if (extracted.exitCode !== 0 || !info?.isFile())
      throw new CliError(
        "local-io",
        `Couldn't extract dotrelay from ${archiveName}. Nothing was installed.`,
      );

    try {
      await copyFile(binary, staged);
      await chmod(staged, 0o755);
    } catch (error) {
      throw installFailure(path, (error as Error).message);
    }
    const check = await capture([staged, "--version"]).catch(() => null);
    if (check?.exitCode !== 0 || check.stdout.trim() !== latest)
      throw new CliError(
        "local-io",
        `The downloaded dotrelay ${latest} doesn't run on this machine. Nothing was changed.`,
      );

    try {
      if (platform === "win32") {
        // Windows can't replace a running executable, but it can rename
        // it out of the way; the old copy is removed on a later update.
        const previous = `${path}.old`;
        await rm(previous, { force: true });
        await rename(path, previous);
        try {
          await rename(staged, path);
        } catch (error) {
          await rename(previous, path).catch(() => {});
          throw error;
        }
      } else {
        await rename(staged, path);
      }
    } catch (error) {
      throw installFailure(path, (error as Error).message);
    }
  } finally {
    await rm(staged, { force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
};

export type UpdateResult = Readonly<{
  message: string;
  previousVersion: string;
  version: string;
  updated: boolean;
  installation: Installation["kind"];
}>;

/** `dotrelay update`: installs the newest release on this binary's channel. */
export const updateCli = async (
  version: string,
  dependencies: UpdateDependencies = {},
): Promise<UpdateResult> => {
  const channel = channelFor(version);
  if (!channel)
    throw new CliError(
      "invocation",
      `This dotrelay (${version}) was built from source, so it can't update itself. Pull the latest code and rebuild it, or install a release: npm install -g ${PACKAGE_NAME}.`,
    );
  const progress = dependencies.progress ?? (() => {});
  progress("Checking for a newer version");
  let latest: string;
  try {
    latest = await fetchPublishedVersion(channel, {
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
  } catch {
    throw new CliError(
      "transient",
      "Couldn't reach the npm registry to look for a newer version. Check your connection and run dotrelay update again.",
    );
  }
  const installation = await detectInstallation(version, dependencies);
  if (!isNewerVersion(version, latest))
    return {
      message: `dotrelay ${version} is the newest version`,
      previousVersion: version,
      version,
      updated: false,
      installation: installation.kind,
    };

  const spec = `${PACKAGE_NAME}@${latest}`;
  if (installation.kind === "package") {
    const which = dependencies.which ?? Bun.which;
    const executable = installation.manager
      ? which(installation.manager)
      : null;
    if (!installation.manager || !executable)
      throw new CliError(
        "invocation",
        `dotrelay ${latest} is available, but this copy (${installation.path}) belongs to a project or a package manager DotRelay can't run for you. Update it there, for example: npm install ${spec}.`,
      );
    const command =
      installation.manager === "bun"
        ? [executable, "add", "--global", spec]
        : [executable, "install", "--global", spec];
    progress(`Running ${installation.manager} ${command.slice(1).join(" ")}`);
    const attach = dependencies.attach ?? defaultAttach;
    const exitCode = await attach(command).catch(() => 1);
    if (exitCode !== 0)
      throw new CliError(
        "local-io",
        `${installation.manager} couldn't install ${spec} (exit code ${exitCode}). Run ${installation.manager === "bun" ? "bun add -g" : "npm install -g"} ${spec} yourself to see why.`,
      );
  } else if (installation.kind === "standalone") {
    if (channel === "dev")
      throw new CliError(
        "invocation",
        `Dev builds are only published to npm. Install the newest one with npm install -g ${PACKAGE_NAME}@dev.`,
      );
    await replaceStandaloneBinary(installation.path, latest, dependencies);
  }
  return {
    message: `Updated dotrelay from ${version} to ${latest}`,
    previousVersion: version,
    version: latest,
    updated: true,
    installation: installation.kind,
  };
};
