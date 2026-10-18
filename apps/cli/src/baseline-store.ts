import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError } from "./errors";
import { atomicWriteProtectedFile } from "./output";

export type StoredPublicationBaseline = Readonly<{
  readonly environmentId: string;
  readonly inputPath: string;
  readonly revisionId: string;
  readonly headHash: string;
}>;

type BaselineFile = Readonly<{
  readonly version: 1;
  readonly entries: readonly StoredPublicationBaseline[];
}>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const publicationBaselinePath = (stateDirectory: string): string =>
  `${stateDirectory}/baselines.json`;

export const publicationBaselineInputPath = (inputPath: string): string =>
  resolve(inputPath);

const invalid = (): never => {
  throw new CliError(
    "local-io",
    "the publication baseline record is invalid",
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
    if (typeof environmentId !== "string" || !UUID.test(environmentId))
      invalid();
    if (typeof inputPath !== "string" || inputPath.length === 0) invalid();
    if (typeof revisionId !== "string" || !UUID.test(revisionId)) invalid();
    if (typeof headHash !== "string" || !/^[0-9a-f]{96}$/i.test(headHash))
      invalid();
    const hash = headHash as string;
    return Object.freeze({
      environmentId: environmentId as string,
      inputPath: inputPath as string,
      revisionId: revisionId as string,
      headHash: hash.toLowerCase(),
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
      "could not read the publication baseline record",
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
  const key = publicationBaselineInputPath(inputPath);
  return (
    stored.entries.find(
      (entry) =>
        entry.environmentId === environmentId && entry.inputPath === key,
    ) ?? null
  );
};

export const writePublicationBaseline = async (
  stateDirectory: string,
  baseline: StoredPublicationBaseline,
): Promise<void> => {
  const path = publicationBaselinePath(stateDirectory);
  const stored = await readFileOrEmpty(path);
  const next = Object.freeze({
    version: 1 as const,
    entries: Object.freeze([
      ...stored.entries.filter(
        (entry) =>
          entry.environmentId !== baseline.environmentId ||
          entry.inputPath !== baseline.inputPath,
      ),
      Object.freeze({
        ...baseline,
        inputPath: publicationBaselineInputPath(baseline.inputPath),
        headHash: baseline.headHash.toLowerCase(),
      }),
    ]),
  });
  validate(next);
  try {
    await atomicWriteProtectedFile(path, `${JSON.stringify(next)}\n`);
  } catch {
    throw new CliError(
      "local-io",
      "could not write the publication baseline record",
      {},
      "baseline_write_failed",
    );
  }
};
