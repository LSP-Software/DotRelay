import {
  chmod,
  mkdir,
  readFile,
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
      "refusing to write Values to terminal stdout; add --reveal explicitly",
      {},
      "unsafe_stdout",
    );
};

const writeProtected = async (path: string, data: string | Uint8Array) => {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new CliError(
      "local-io",
      "could not atomically write the requested output",
      {},
      "output_write_failed",
    );
  }
};

const retainPreviousFile = async (path: string): Promise<void> => {
  const previousPath = `${path}.previous`;
  const temporary = join(
    dirname(path),
    `.${basename(path)}.previous.${crypto.randomUUID()}.tmp`,
  );
  try {
    const prior = await readFile(path);
    try {
      await writeFile(temporary, prior, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, previousPath);
      if (process.platform !== "win32") await chmod(previousPath, 0o600);
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new CliError(
        "local-io",
        "could not retain a recoverable copy of the prior file",
        {},
        "output_write_failed",
      );
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new CliError(
        "local-io",
        "could not read the prior file for the recoverable copy",
        {},
        "output_write_failed",
      );
  }
};

export const atomicWriteProtectedFile = async (
  path: string,
  contents: string,
  options: Readonly<{ readonly retainPrevious?: boolean }> = {},
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (options.retainPrevious === true) await retainPreviousFile(path);
  await writeProtected(path, contents);
};
