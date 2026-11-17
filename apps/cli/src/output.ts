import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CliError } from "./errors";

export const assertSafeStdout = (
  options: Readonly<{
    requested: boolean;
    terminal: boolean;
    reveal?: boolean;
  }>,
): void => {
  if (!options.requested) return;
  if (options.terminal && options.reveal !== true)
    throw new CliError(
      "invocation",
      "--stdout would print the values in your terminal. Add --reveal to allow that.",
      {},
      "unsafe_stdout",
    );
};

export const protectedTemporaryPath = (path: string): string =>
  join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);

// Renames are durable only once the directory entry itself reaches disk.
// Platforms that cannot open a directory for syncing keep the best effort.
const syncDirectory = async (directory: string): Promise<void> => {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Some file systems refuse fsync on a directory; the rename stands.
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

// A dotenv path is often a symlink into a shared checkout. Renaming over
// the link would replace it with a regular file, so the write lands on the
// file the link points at instead.
export const resolveOutputTarget = async (path: string): Promise<string> => {
  try {
    if ((await lstat(path)).isSymbolicLink()) return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
  return path;
};

const writeProtected = async (
  path: string,
  data: string | Uint8Array,
  followSymlink: boolean,
) => {
  let temporary: string | undefined;
  try {
    const target = followSymlink ? await resolveOutputTarget(path) : path;
    temporary = protectedTemporaryPath(target);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    if (process.platform !== "win32") await chmod(target, 0o600);
    await syncDirectory(dirname(target));
  } catch {
    if (temporary) await unlink(temporary).catch(() => undefined);
    throw new CliError(
      "local-io",
      "couldn't write the output file",
      {},
      "output_write_failed",
    );
  }
};

/** How many earlier copies of a replaced file are kept beside it. */
export const RETAINED_PREVIOUS_COPIES = 3;

/**
 * The recoverable copies of `path`, newest first: `<path>.previous`, then
 * `<path>.previous.1`, `<path>.previous.2`. Every one holds plaintext, so
 * callers that guard the output against Git guard all of them.
 */
export const previousFilePaths = (path: string): readonly string[] =>
  Array.from({ length: RETAINED_PREVIOUS_COPIES }, (_, index) =>
    index === 0 ? `${path}.previous` : `${path}.previous.${index}`,
  );

const readIfPresent = async (path: string): Promise<Buffer | null> => {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const sameBytes = (left: Uint8Array, right: string | Uint8Array): boolean =>
  Buffer.from(left).equals(
    typeof right === "string" ? Buffer.from(right, "utf8") : Buffer.from(right),
  );

// Keeps the replaced file as `<path>.previous` and shifts older copies down
// the rotation. A copy identical to the file being written, or to the
// newest copy already kept, is not retained again, so a repeated write can
// never push the one useful copy out of the rotation.
const retainPreviousFile = async (
  path: string,
  next: string | Uint8Array,
): Promise<void> => {
  const slots = previousFilePaths(path);
  const newest = slots[0] ?? `${path}.previous`;
  let prior: Buffer | null;
  let kept: Buffer | null;
  try {
    prior = await readIfPresent(path);
    kept = prior === null ? null : await readIfPresent(newest);
  } catch {
    throw new CliError(
      "local-io",
      "couldn't read the existing file to keep a copy of it, so the new one wasn't written",
      {},
      "output_write_failed",
    );
  }
  if (prior === null || sameBytes(prior, next)) return;
  if (kept !== null && sameBytes(kept, prior)) return;
  const temporary = protectedTemporaryPath(newest);
  try {
    for (let index = slots.length - 1; index > 0; index -= 1) {
      const from = slots[index - 1];
      const to = slots[index];
      if (!from || !to) continue;
      try {
        await rename(from, to);
        if (process.platform !== "win32") await chmod(to, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await writeFile(temporary, prior, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, newest);
    if (process.platform !== "win32") await chmod(newest, 0o600);
    await syncDirectory(dirname(newest));
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new CliError(
      "local-io",
      "couldn't keep a copy of the existing file, so the new one wasn't written",
      {},
      "output_write_failed",
    );
  }
};

export const atomicWriteProtectedFile = async (
  path: string,
  contents: string | Uint8Array,
  options: Readonly<{
    readonly retainPrevious?: boolean;
    /**
     * Write through a symlink at `path` to the file it names instead of
     * replacing the link. Only user-chosen outputs opt in; state files keep
     * replacing whatever sits at their path.
     */
    readonly followSymlink?: boolean;
  }> = {},
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (options.retainPrevious === true) await retainPreviousFile(path, contents);
  await writeProtected(path, contents, options.followSymlink === true);
};
