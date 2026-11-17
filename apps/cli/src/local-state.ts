import { chmod, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./errors";

// The CLI state directory holds the credential store's key beside the
// sessions and Device keys it wraps, so the files are only as private as
// their modes. Directories are kept at 0700 and files at 0600 on every run,
// which also repairs state written by an older version or copied in with a
// wider umask. Symlinks are never followed, and an entry owned by another
// user stops the command rather than being trusted.
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;

const foreignOwner = (path: string): CliError =>
  new CliError(
    "local-io",
    `${path} belongs to another user. DotRelay keeps keys here, so it won't use it. Remove it, or set DOTRELAY_CONFIG_DIR to a directory you own.`,
    {},
    "state_permissions_invalid",
  );

type Kind = "directory" | "file";

// Restricts one entry the CLI owns and reports what it is; links and
// missing entries are skipped.
const restrict = async (path: string): Promise<Kind | null> => {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink()) return null;
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw foreignOwner(path);
  if (info.isDirectory()) {
    if ((info.mode & 0o777) !== PRIVATE_DIRECTORY)
      await chmod(path, PRIVATE_DIRECTORY);
    return "directory";
  }
  if (!info.isFile()) return null;
  if ((info.mode & 0o077) !== 0) await chmod(path, PRIVATE_FILE);
  return "file";
};

// Only what the CLI itself writes is touched: the directory, its JSON state
// files, and the credential store. DOTRELAY_CONFIG_DIR may name a directory
// that also holds the user's own files, which keep their modes.
const hardenEntries = async (directory: string): Promise<void> => {
  if ((await restrict(directory)) !== "directory") return;
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if (name === "credentials") {
      if ((await restrict(path)) !== "directory") continue;
      for (const entry of await readdir(path))
        await restrict(join(path, entry));
    } else if (name.endsWith(".json") || name.endsWith(".json.previous"))
      await restrict(path);
  }
};

export const hardenLocalState = async (directory: string): Promise<void> => {
  if (process.platform === "win32") return;
  try {
    await hardenEntries(directory);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "local-io",
      `Couldn't make the DotRelay state directory ${directory} private. Check that you own it.`,
      {},
      "state_permissions_invalid",
    );
  }
};
