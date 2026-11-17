import { realpathSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError } from "./errors";
import { atomicWriteProtectedFile } from "./output";

export type StoredPublicationBaseline = Readonly<{
  readonly environmentId: string;
  readonly inputPath: string;
  readonly revisionId: string;
  readonly headHash: string;
  /**
   * `pull` when the file was written from this Revision; `fallback` when
   * push or init met a file with no recorded baseline and anchored it at the
   * head it saw. A fallback says nothing about where the file came from, so
   * later publications keep treating it as unrecorded. Entries written
   * before this field existed read as `pull`.
   */
  readonly origin?: "pull" | "fallback";
}>;

type BaselineFile = Readonly<{
  readonly version: 1;
  readonly entries: readonly StoredPublicationBaseline[];
}>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const publicationBaselinePath = (stateDirectory: string): string =>
  `${stateDirectory}/baselines.json`;

/**
 * The key a baseline is stored under: the file's real path when it exists,
 * so a symlinked worktree path and the path it points at share one record.
 */
export const publicationBaselineInputPath = (inputPath: string): string => {
  const absolute = resolve(inputPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
};

const inputPathKeys = (inputPath: string): ReadonlySet<string> =>
  new Set([publicationBaselineInputPath(inputPath), resolve(inputPath)]);

const invalid = (): never => {
  throw new CliError(
    "local-io",
    "this machine's record of which revision your file is based on is corrupt",
    {},
    "baseline_invalid",
  );
};

const validate = (value: unknown): BaselineFile => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  const object = value as Record<string, unknown>;
  const rawEntries = object.entries;
  if (object.version !== 1 || !Array.isArray(rawEntries)) invalid();
  const entries = (rawEntries as readonly unknown[]).map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      invalid();
    const record = entry as Record<string, unknown>;
    const environmentId = record.environmentId;
    const inputPath = record.inputPath;
    const revisionId = record.revisionId;
    const headHash = record.headHash;
    const origin = record.origin;
    if (typeof environmentId !== "string" || !UUID.test(environmentId))
      invalid();
    if (typeof inputPath !== "string" || inputPath.length === 0) invalid();
    if (typeof revisionId !== "string" || !UUID.test(revisionId)) invalid();
    if (typeof headHash !== "string" || !/^[0-9a-f]{96}$/i.test(headHash))
      invalid();
    if (origin !== undefined && origin !== "pull" && origin !== "fallback")
      invalid();
    const hash = headHash as string;
    return Object.freeze({
      environmentId: environmentId as string,
      inputPath: inputPath as string,
      revisionId: revisionId as string,
      headHash: hash.toLowerCase(),
      ...(origin === "fallback" ? { origin: "fallback" as const } : {}),
    });
  });
  return Object.freeze({ version: 1, entries: Object.freeze(entries) });
};

const readFileOrEmpty = async (path: string): Promise<BaselineFile> => {
  try {
    return validate(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return Object.freeze({ version: 1, entries: Object.freeze([]) });
    if (error instanceof CliError) throw error;
    throw new CliError(
      "local-io",
      "couldn't read this machine's record of which revision your file is based on",
      {},
      "baseline_read_failed",
    );
  }
};

export const readPublicationBaseline = async (
  stateDirectory: string,
  environmentId: string,
  inputPath: string,
): Promise<StoredPublicationBaseline | null> => {
  const stored = await readFileOrEmpty(publicationBaselinePath(stateDirectory));
  const keys = inputPathKeys(inputPath);
  return (
    // Older versions could store duplicates; the last entry is the newest.
    [...stored.entries]
      .reverse()
      .find(
        (entry) =>
          entry.environmentId === environmentId && keys.has(entry.inputPath),
      ) ?? null
  );
};

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;

const lockFailed = (): never => {
  throw new CliError(
    "local-io",
    "another dotrelay command is updating the same record. Try again when it finishes.",
    {},
    "baseline_write_failed",
  );
};

/**
 * Serializes read-modify-write of baselines.json across processes with an
 * exclusive lock file. A lock older than LOCK_STALE_MS belongs to a process
 * that died mid-update and is broken; a live holder finishes in well under
 * a second.
 */
const withBaselineLock = async <T>(
  stateDirectory: string,
  action: () => Promise<T>,
): Promise<T> => {
  const lockPath = `${publicationBaselinePath(stateDirectory)}.lock`;
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 }).catch(
    () => undefined,
  );
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") lockFailed();
      const age = await stat(lockPath).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) lockFailed();
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, LOCK_RETRY_MS),
      );
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`).catch(() => undefined);
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
};

export const writePublicationBaseline = async (
  stateDirectory: string,
  baseline: StoredPublicationBaseline,
): Promise<void> => {
  const path = publicationBaselinePath(stateDirectory);
  const keys = inputPathKeys(baseline.inputPath);
  await withBaselineLock(stateDirectory, async () => {
    const stored = await readFileOrEmpty(path);
    const next = Object.freeze({
      version: 1 as const,
      entries: Object.freeze([
        ...stored.entries.filter(
          (entry) =>
            entry.environmentId !== baseline.environmentId ||
            !keys.has(entry.inputPath),
        ),
        Object.freeze({
          environmentId: baseline.environmentId,
          inputPath: publicationBaselineInputPath(baseline.inputPath),
          revisionId: baseline.revisionId,
          headHash: baseline.headHash.toLowerCase(),
          ...(baseline.origin === "fallback"
            ? { origin: "fallback" as const }
            : {}),
        }),
      ]),
    });
    validate(next);
    try {
      await atomicWriteProtectedFile(path, `${JSON.stringify(next)}\n`);
    } catch {
      throw new CliError(
        "local-io",
        "couldn't save this machine's record of which revision your file is based on",
        {},
        "baseline_write_failed",
      );
    }
  });
};
