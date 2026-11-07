import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  readWorktreeContext,
  type WorktreeContext,
  writeWorktreeContext,
} from "./context";
import { CliError, CliInvocationError } from "./errors";
import { atomicWriteProtectedFile } from "./output";

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

export const backupMetadataContents = async (
  stateDirectory: string,
  label: string,
  contents: string,
): Promise<string> => {
  await mkdir(stateDirectory, { recursive: true });
  const path = join(stateDirectory, `${label}-${stamp()}.json`);
  const body = contents.endsWith("\n") ? contents : `${contents}\n`;
  await atomicWriteProtectedFile(path, body);
  return path;
};

const HEAD_FILE = /^head-([0-9a-f-]{36})\.json$/i;

// The Server Profile identity a trusted head record was verified against, or
// null when the record does not name one (older records) or is unreadable.
const headServerProfileId = async (path: string): Promise<string | null> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return null;
    const id = (value as Record<string, unknown>).serverProfileId;
    return typeof id === "string" ? id.toLowerCase() : null;
  } catch {
    return null;
  }
};

// Drops the publication baselines of the reset Environments and keeps every
// other entry. A baseline file that cannot be read is left as it is.
const removeBaselines = async (
  stateDirectory: string,
  environmentIds: ReadonlySet<string>,
): Promise<void> => {
  const path = join(stateDirectory, "baselines.json");
  let stored: unknown;
  try {
    stored = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return;
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored))
    return;
  const entries = (stored as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return;
  const kept = entries.filter((entry: unknown) => {
    const environmentId =
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>).environmentId
        : undefined;
    return (
      typeof environmentId !== "string" ||
      !environmentIds.has(environmentId.toLowerCase())
    );
  });
  if (kept.length === entries.length) return;
  await atomicWriteProtectedFile(
    path,
    `${JSON.stringify({ ...stored, entries: kept })}\n`,
  );
};

// Resets trusted Revision continuity for the Environments verified against
// one Server Profile identity: their trusted head records and publication
// baselines. Records of other profiles, and records that do not name the
// identity they were verified against, are kept.
export const resetTrustedEnvironmentHistory = async (
  stateDirectory: string,
  serverProfileId: string,
): Promise<number> => {
  let names: string[];
  try {
    names = await readdir(stateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new CliError(
      "local-io",
      "could not read the local state directory",
      {},
      "trusted_head_read_failed",
    );
  }
  const profileId = serverProfileId.toLowerCase();
  const reset = new Set<string>();
  for (const name of names) {
    const environmentId = HEAD_FILE.exec(name)?.[1];
    if (environmentId === undefined) continue;
    const path = join(stateDirectory, name);
    if ((await headServerProfileId(path)) !== profileId) continue;
    await unlink(path);
    reset.add(environmentId.toLowerCase());
  }
  if (reset.size > 0) await removeBaselines(stateDirectory, reset);
  return reset.size;
};

const withoutNavigation = (context: WorktreeContext): WorktreeContext =>
  Object.freeze({
    ...(context.serverProfileId === undefined
      ? {}
      : { serverProfileId: context.serverProfileId }),
    ...(context.repositoryRemote === undefined
      ? {}
      : { repositoryRemote: context.repositoryRemote }),
    ...(context.repositoryOwner === undefined
      ? {}
      : { repositoryOwner: context.repositoryOwner }),
    ...(context.repositoryName === undefined
      ? {}
      : { repositoryName: context.repositoryName }),
    ...(context.repositoryIdentity === undefined
      ? {}
      : { repositoryIdentity: context.repositoryIdentity }),
  });

export const reselectWorktreeNavigation = async (
  input: Readonly<{
    readonly contextPath: string;
    readonly stateDirectory: string;
    readonly approve: (statement: string) => Promise<boolean>;
  }>,
): Promise<
  Readonly<{
    readonly backupPath: string;
    readonly removed: boolean;
    readonly projectCleared: boolean;
    readonly environmentCleared: boolean;
  }>
> => {
  let raw: string;
  try {
    raw = await readFile(input.contextPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new CliInvocationError(
        "no worktree context is recorded; run dotrelay context",
      );
    throw new CliError(
      "local-io",
      "could not read worktree context",
      {},
      "context_read_failed",
    );
  }
  let context: WorktreeContext | null = null;
  let invalid = false;
  try {
    context = await readWorktreeContext(input.contextPath);
  } catch (error) {
    if (!(error instanceof CliInvocationError)) throw error;
    invalid = true;
  }
  const projectCleared = invalid || context?.projectId !== undefined;
  const environmentCleared = invalid || context?.environmentId !== undefined;
  const statement = invalid
    ? "The stored worktree context is invalid. Reselect will back it up and remove it. Device keys and trusted Revision history are kept."
    : "Reselect the Project and Environment recorded for this worktree. Device keys and trusted Revision history are kept. The current worktree context is backed up first.";
  if (!(await input.approve(statement)))
    throw new CliInvocationError(
      "context reselect was declined; nothing was changed",
    );
  const backupPath = await backupMetadataContents(
    input.stateDirectory,
    "worktree-context",
    raw,
  );
  if (invalid || context === null) {
    await unlink(input.contextPath);
    return Object.freeze({
      backupPath,
      removed: true,
      projectCleared,
      environmentCleared,
    });
  }
  await writeWorktreeContext(input.contextPath, withoutNavigation(context));
  return Object.freeze({
    backupPath,
    removed: false,
    projectCleared,
    environmentCleared,
  });
};
