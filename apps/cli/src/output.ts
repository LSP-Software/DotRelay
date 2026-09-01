import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
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

export const atomicWriteProtectedFile = async (
  path: string,
  contents: string,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
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
