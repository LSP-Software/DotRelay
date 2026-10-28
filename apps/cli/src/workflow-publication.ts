import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertPublicationAccepted,
  type BaselineConflict,
  type BaselineResolution,
  changedVariableIdsSinceBaseline,
  createPublicationArtifacts,
  type DecodedVariable,
  decodeSyncVariables,
  type PublicationContext,
  reconcilePublicationBaseline,
  reviewPublication,
  type SyncPageWire,
  withResolvedConflicts,
} from "@dotrelay/client";
import { generateEncryptionKeyPair, sha384 } from "@dotrelay/contracts";
import { listEnvironments, listTeams } from "./admin";
import type { ParsedArguments } from "./args";
import {
  readPublicationBaseline,
  writePublicationBaseline,
} from "./baseline-store";
import { classifyVariablesInteractively } from "./classify-ui";
import { reviewFrame, stepDone } from "./components";
import {
  type ClassifiedDotenvEntry,
  classifyDotenv,
  type DotenvDiffChange,
  type DotenvEntry,
  diffDotenvEntries,
  parseDotenv,
} from "./dotenv";
import { CliError, CliInvocationError, sanitizeCliText } from "./errors";
import {
  createGitTrackingProbe,
  ensureLocalGitExclusion,
} from "./git-tracking";
import { createProgress, type Progress } from "./progress";
import { paint } from "./ui";
import {
  type PublicationChange,
  type PublicationDestination,
  publicationConfirmQuestion,
  ROLLBACK_NOTE,
  reviewBody,
  rollbackConfirmQuestion,
  type ValueOwnership,
  valueDiffsForPull,
} from "./value-diff";
import {
  adminClient,
  ask,
  bytesToHex,
  confirmSilent,
  safeProjectEpoch,
  type WorkflowOptions,
} from "./workflow-core";
import { syncWorkflow } from "./workflow-session";
export const classificationFromOwnership = (
  ownership: DecodedVariable["ownership"],
): "shared" | "user-defined" =>
  ownership === "SHARED_VALUE" ? "shared" : "user-defined";

export const toDotenvClassifications = (
  classifications: Readonly<Record<string, "shared" | "user-defined">>,
) =>
  Object.fromEntries(
    Object.entries(classifications).map(([name, classification]) => [
      name,
      { classification },
    ]),
  );

export const classify = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
  entries: readonly DotenvEntry[],
  existing: readonly DecodedVariable[],
): Promise<readonly ClassifiedDotenvEntry[]> => {
  const provided: Record<string, "shared" | "user-defined"> = {
    ...parsed.classifications,
  };
  for (const variable of existing) {
    if (variable.tombstone) continue;
    if (!(variable.name in provided))
      provided[variable.name] = classificationFromOwnership(variable.ownership);
  }
  const missing = entries.filter((entry) => !(entry.name in provided));
  if (missing.length === 0)
    return classifyDotenv(entries, toDotenvClassifications(provided));
  if (options.noInput)
    throw new CliInvocationError(
      "new Variables require --classify NAME=shared|user-defined under --no-input",
    );
  const selected = await classifyVariablesInteractively(
    missing.map((entry) => entry.name),
    provided,
    {
      ...(options.terminal ? { terminal: options.terminal } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    },
  );
  return classifyDotenv(
    entries,
    toDotenvClassifications({ ...provided, ...selected }),
  );
};

export const variablesFromDotenv = (
  entries: readonly ClassifiedDotenvEntry[],
  existing: readonly DecodedVariable[],
): readonly DecodedVariable[] => {
  const used = new Set<string>();
  const variables = entries.map((entry) => {
    const prior = existing.find(
      (candidate) => candidate.name === entry.name && !candidate.tombstone,
    );
    if (
      prior &&
      prior.ownership !==
        (entry.classification === "shared"
          ? "SHARED_VALUE"
          : "USER_DEFINED_VALUE")
    )
      throw new CliInvocationError(
        `classification for ${entry.name} does not match the existing Variable`,
      );
    const variable = {
      id: prior?.id ?? crypto.randomUUID(),
      name: entry.name,
      description: prior?.description ?? "",
      ownership:
        entry.classification === "shared"
          ? ("SHARED_VALUE" as const)
          : ("USER_DEFINED_VALUE" as const),
      value: entry.value,
      required: prior?.required ?? true,
      tombstone: false,
    };
    used.add(variable.id);
    return Object.freeze(variable);
  });
  return Object.freeze([
    ...variables,
    ...existing
      .filter((variable) => !used.has(variable.id) && !variable.tombstone)
      .map((variable) =>
        variable.value === null
          ? Object.freeze({ ...variable })
          : Object.freeze({ ...variable, value: null, tombstone: true }),
      ),
  ]);
};

export const toPublicationVariable = (
  variable: DecodedVariable,
  existing: readonly DecodedVariable[],
): Parameters<typeof createPublicationArtifacts>[0][number] => {
  const prior = existing.find((candidate) => candidate.id === variable.id);
  return {
    ...variable,
    hasDraftChange:
      !prior ||
      prior.name !== variable.name ||
      prior.description !== variable.description ||
      prior.ownership !== variable.ownership ||
      prior.value !== variable.value ||
      prior.required !== variable.required ||
      prior.tombstone !== variable.tombstone,
  };
};

export type PublicationDraft = ReturnType<typeof toPublicationVariable>;

export const publicationChangeFor = (
  variable: PublicationDraft,
  existing: readonly DecodedVariable[],
): PublicationChange | null => {
  if (!variable.hasDraftChange) return null;
  const prior = existing.find((candidate) => candidate.id === variable.id);
  const ownership = classificationFromOwnership(variable.ownership);
  if (variable.tombstone)
    return Object.freeze({
      kind: "removed",
      name: variable.name,
      from: prior?.value ?? null,
      to: undefined,
      ownership,
    });
  if (!prior || prior.tombstone)
    return Object.freeze({
      kind: "added",
      name: variable.name,
      from: undefined,
      to: variable.value,
      ownership,
    });
  return Object.freeze({
    kind: "updated",
    name: variable.name,
    from: prior.value,
    to: variable.value,
    ownership,
  });
};

export const destinationFor = async (
  options: WorkflowOptions,
  context: PublicationContext,
): Promise<PublicationDestination> => {
  // A missing metadata lookup degrades the review to opaque ids; it must
  // never block an operation the operator is about to confirm.
  let environment:
    | Awaited<ReturnType<typeof listEnvironments>>[number]
    | undefined;
  let team: Awaited<ReturnType<typeof listTeams>>[number] | undefined;
  try {
    const admin = adminClient(options);
    const [environments, teams] = await Promise.all([
      listEnvironments(admin, context.projectId),
      listTeams(admin),
    ]);
    environment = environments.find(
      (entry) => entry.id === context.environmentId,
    );
    team = teams.find((entry) => entry.id === context.teamId);
  } catch {
    // Keep the confirmation reachable even when metadata is unavailable.
  }
  return Object.freeze({
    profile: options.profile.name,
    team: team?.name ?? context.teamId ?? "unknown",
    project: context.projectId,
    environment: environment?.label ?? context.environmentId ?? "unknown",
  });
};

export type PublicationReconciliation = Readonly<{
  readonly baseline: readonly DecodedVariable[];
  readonly draft: readonly DecodedVariable[];
  readonly baselineRevisionId: string;
  readonly baselineHash: Uint8Array;
  readonly emptyAnchor: boolean;
  readonly environmentId: string;
  readonly actorUserId: string;
}>;

const sameHash = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

const baselineStillVerifiable = (
  page: SyncPageWire,
  reconciliation: PublicationReconciliation,
): boolean => {
  if (reconciliation.emptyAnchor) return true;
  return page.revisions.some(
    (revision) =>
      revision.id === reconciliation.baselineRevisionId &&
      sameHash(revision.digest, reconciliation.baselineHash),
  );
};

const maskConflictValue = (
  value: string | null | undefined,
  reveal: boolean,
  unreadable: boolean,
): string => {
  if (unreadable)
    return "changed on another Device; value not readable on this Device";
  if (value === undefined) return "absent";
  if (value === null) return "not set";
  return reveal ? value : "••••";
};

const conflictLines = (
  conflict: BaselineConflict,
  reveal: boolean,
): readonly string[] => {
  const ownership =
    conflict.local?.ownership ?? conflict.remote?.ownership ?? "SHARED_VALUE";
  const label = ownership === "SHARED_VALUE" ? "shared" : "user-defined";
  return [
    `${conflict.name} (${label}) conflicts: ${conflict.kinds.join(", ")}`,
    `  base: ${maskConflictValue(conflict.base?.tombstone ? undefined : conflict.base?.value, reveal, false)}`,
    `  local: ${maskConflictValue(conflict.local?.tombstone ? undefined : conflict.local?.value, reveal, false)}`,
    `  remote: ${maskConflictValue(
      conflict.remote?.tombstone ? undefined : conflict.remote?.value,
      reveal,
      conflict.remoteUnreadable,
    )}`,
    conflict.otherUserOwned
      ? "  This Value is owned by another User. The only choice is keep remote."
      : `  Choose ${conflict.choices.join(", ")}.`,
  ];
};

const normalizeResolution = (
  answer: string,
  choices: readonly BaselineResolution[],
): BaselineResolution | null => {
  const normalized = answer.trim().toLowerCase().replace(/\s+/g, " ");
  const choice = (
    normalized === "keep local"
      ? "local"
      : normalized === "keep remote"
        ? "remote"
        : normalized
  ) as BaselineResolution;
  return choices.includes(choice) ? choice : null;
};

const resolveConflicts = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
  conflicts: readonly BaselineConflict[],
): Promise<ReadonlyMap<string, BaselineResolution>> => {
  if (conflicts.length === 0) return new Map();
  const names = conflicts.map((conflict) => conflict.name).join(", ");
  if (options.noInput)
    throw new CliError(
      "conflict",
      `publication paused because ${names} changed both locally and on the Server Profile. Nothing was published and the input file is unchanged. Re-run without --no-input to choose which side to keep.`,
      {
        conflictCount: conflicts.length,
        variableNames: names.slice(0, 512),
      },
      "variable_conflict",
    );
  const output = options.terminal?.output ?? process.stderr;
  const choices = new Map<string, BaselineResolution>();
  for (const conflict of conflicts) {
    output.write(`${conflictLines(conflict, parsed.reveal).join("\n")}\n`);
    const answer = await ask(
      options,
      `Choose for ${conflict.name} (${conflict.choices.join(" / ")})`,
    );
    const choice = normalizeResolution(answer, conflict.choices);
    if (!choice)
      throw new CliInvocationError(
        `choose one of ${conflict.choices.join(", ")} for ${conflict.name}`,
      );
    choices.set(conflict.key, choice);
  }
  return choices;
};

const zeroHash = (): Uint8Array => new Uint8Array(48);

const hashFromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

export const preparePublicationBaseline = async (
  options: WorkflowOptions,
  synced: Awaited<ReturnType<typeof syncWorkflow>>,
  inputPath: string,
): Promise<
  Readonly<{
    readonly snapshot: readonly DecodedVariable[];
    readonly notice: string | null;
    readonly reconciliation: Omit<PublicationReconciliation, "draft">;
  }>
> => {
  const environmentId = synced.page.environmentId;
  const currentId = synced.page.currentHeadId ?? environmentId;
  const currentHash = synced.page.currentHeadHash ?? zeroHash();
  const currentEmpty = synced.page.currentHeadId === null;
  const recorded = await readPublicationBaseline(
    options.stateDirectory,
    environmentId,
    inputPath,
  );
  const recordedEmpty =
    recorded !== null &&
    recorded.revisionId === environmentId &&
    recorded.headHash === "0".repeat(96);
  const recordedVerifiable =
    recorded !== null &&
    (recordedEmpty ||
      synced.page.revisions.some(
        (revision) =>
          revision.id === recorded.revisionId &&
          bytesToHex(revision.digest) === recorded.headHash,
      ));
  const fallbackNotice =
    "The recorded Publication Baseline is no longer in verified history, so this publication is reconciled against the Environment as it is now.";
  const persistFallback = async (
    notice: string | null,
  ): Promise<
    Readonly<{
      readonly snapshot: readonly DecodedVariable[];
      readonly notice: string | null;
      readonly reconciliation: Omit<PublicationReconciliation, "draft">;
    }>
  > => {
    await writePublicationBaseline(options.stateDirectory, {
      environmentId,
      inputPath,
      revisionId: currentId,
      headHash: bytesToHex(currentHash),
    });
    return Object.freeze({
      snapshot: synced.variables,
      notice,
      reconciliation: Object.freeze({
        baseline: synced.variables,
        baselineRevisionId: currentId,
        baselineHash: currentHash,
        emptyAnchor: currentEmpty,
        environmentId,
        actorUserId: synced.workflow.publicationContext.actorUserId,
      }),
    });
  };
  if (!recorded || !recordedVerifiable)
    return persistFallback(recorded ? fallbackNotice : null);
  if (recordedEmpty)
    return Object.freeze({
      snapshot: Object.freeze([]),
      notice: null,
      reconciliation: Object.freeze({
        baseline: Object.freeze([]),
        baselineRevisionId: environmentId,
        baselineHash: zeroHash(),
        emptyAnchor: true,
        environmentId,
        actorUserId: synced.workflow.publicationContext.actorUserId,
      }),
    });
  const snapshot = synced.workflow.session
    .revisionSnapshots()
    .get(recorded.revisionId);
  if (!snapshot) return persistFallback(fallbackNotice);
  return Object.freeze({
    snapshot,
    notice: null,
    reconciliation: Object.freeze({
      baseline: snapshot,
      baselineRevisionId: recorded.revisionId,
      baselineHash: hashFromHex(recorded.headHash),
      emptyAnchor: false,
      environmentId,
      actorUserId: synced.workflow.publicationContext.actorUserId,
    }),
  });
};

const draftForRollback = (
  remote: readonly DecodedVariable[],
  prepared: readonly DecodedVariable[],
  rollback: Readonly<{
    target: string;
    ids: readonly string[];
    values: ReadonlyMap<string, string | null>;
  }>,
): readonly PublicationDraft[] => {
  const selected = new Set(rollback.ids);
  const remoteIds = new Set(remote.map((variable) => variable.id));
  const fromRemote = remote.map((variable) => {
    if (!selected.has(variable.id))
      return Object.freeze({ ...variable, hasDraftChange: false });
    const value = rollback.values.get(variable.id);
    const next = Object.freeze({
      ...variable,
      value: value === undefined ? variable.value : value,
    });
    return toPublicationVariable(next, remote);
  });
  const restored = prepared
    .filter(
      (variable) => selected.has(variable.id) && !remoteIds.has(variable.id),
    )
    .map((variable) =>
      Object.freeze({
        ...variable,
        value: rollback.values.get(variable.id) ?? variable.value,
        hasDraftChange: true,
      }),
    );
  return Object.freeze([...fromRemote, ...restored]);
};

export const publish = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
  variables: readonly DecodedVariable[],
  mutation: "GENESIS" | "MANIFEST_UPDATE" | "ROLLBACK",
  rollback?: Readonly<{
    target: string;
    ids: readonly string[];
    values: ReadonlyMap<string, string | null>;
  }>,
  reconciliation?: PublicationReconciliation,
): Promise<Record<string, unknown>> => {
  const synced = await syncWorkflow(options, parsed);
  let draftVariables: readonly PublicationDraft[];
  if (mutation === "ROLLBACK" && rollback)
    draftVariables = draftForRollback(synced.variables, variables, rollback);
  else if (reconciliation) {
    if (!baselineStillVerifiable(synced.page, reconciliation))
      throw new CliError(
        "conflict",
        "the recorded Publication Baseline is no longer in verified history. Nothing was published and the input file is unchanged. Run dotrelay pull, then try again.",
        {},
        "baseline_unverifiable",
      );
    const outcome = reconcilePublicationBaseline({
      baseline: reconciliation.baseline,
      draft: reconciliation.draft,
      remote: synced.variables,
      remoteChangedVariableIds: changedVariableIdsSinceBaseline(
        synced.page,
        reconciliation.baselineRevisionId,
        reconciliation.emptyAnchor,
      ),
      actorUserId: reconciliation.actorUserId,
    });
    const choices = await resolveConflicts(options, parsed, outcome.conflicts);
    draftVariables = withResolvedConflicts(outcome, choices);
  } else
    draftVariables = variables.map((variable) =>
      toPublicationVariable(variable, synced.variables),
    );
  const effectiveMutation =
    mutation === "ROLLBACK"
      ? "ROLLBACK"
      : synced.page.currentHeadId === null
        ? "GENESIS"
        : "MANIFEST_UPDATE";
  const context: PublicationContext = {
    ...synced.workflow.publicationContext,
    expectedHeadId: synced.page.currentHeadId,
    expectedHeadHash: synced.page.currentHeadHash,
    projectEpoch: safeProjectEpoch(synced.page.projectEpoch),
    mutation: effectiveMutation,
    ...(rollback
      ? {
          rollbackTargetId: rollback.target,
          rollbackSelectedVariableIds: rollback.ids,
        }
      : {}),
  };
  if (!draftVariables.some((variable) => variable.hasDraftChange))
    return {
      revision: synced.page.currentHeadId,
      lanes: 0,
      tombstones: 0,
      message: "up to date, nothing to publish",
      ...pendingActionsField(synced.workflow.pendingActions),
    };
  const changes = draftVariables
    .map((variable) => publicationChangeFor(variable, synced.variables))
    .filter((change): change is PublicationChange => change !== null);
  const removedCount = changes.filter(
    (change) => change.kind === "removed",
  ).length;
  if (options.noInput && removedCount > 0 && !options.force)
    throw new CliError(
      "invocation",
      `publishing ${removedCount} removed ${removedCount === 1 ? "Variable" : "Variables"} requires explicit approval; re-run with --force`,
      { changedCount: removedCount },
      "deletion_requires_approval",
    );
  if (!options.noInput) {
    const destination = await destinationFor(
      options,
      synced.workflow.publicationContext,
    );
    const output = options.terminal?.output ?? process.stderr;
    const environment = destination.environment;
    if (mutation === "ROLLBACK") {
      // The rollback review names the append-only consequence: the operator
      // approves adding a Rollback Revision, not rewriting earlier ones.
      const frame = reviewFrame({
        title: `Review — roll back in ${environment}`,
        danger: true,
        body: reviewBody(changes, destination, parsed.reveal, [
          `  ${paint(ROLLBACK_NOTE, "faint")}`,
        ]),
        question: rollbackConfirmQuestion(),
      });
      output.write(`${frame}\n`);
      if (!(await confirmSilent(options, rollbackConfirmQuestion())))
        throw new CliInvocationError("rollback confirmation was declined");
    } else {
      const frame = reviewFrame({
        title: `Review — publish to ${environment}`,
        body: reviewBody(changes, destination, parsed.reveal),
        question: publicationConfirmQuestion(),
      });
      output.write(`${frame}\n`);
      if (!(await confirmSilent(options, publicationConfirmQuestion())))
        throw new CliInvocationError("publication confirmation was declined");
    }
  }
  const progress: Progress = createProgress({
    output: options.terminal?.output ?? process.stderr,
    live: (options.terminal?.output as { isTTY?: boolean })?.isTTY === true,
    quiet: options.noInput || parsed.json,
  });
  progress.start("Encrypting values");
  let artifacts: Awaited<ReturnType<typeof createPublicationArtifacts>>;
  try {
    artifacts = await createPublicationArtifacts(draftVariables, context);
    assertPublicationAccepted(reviewPublication(artifacts.commandBytes));
  } catch (error) {
    progress.fail("Encrypting values");
    if (error instanceof CliError) throw error;
    throw new CliError(
      "invocation",
      sanitizeCliText(
        error instanceof Error
          ? error.message
          : "could not build the publication",
      ).slice(0, 512) || "could not build the publication",
      {},
      "publication_invalid",
    );
  }
  const changedCount = draftVariables.filter(
    (variable) => variable.hasDraftChange,
  ).length;
  progress.done(
    `Encrypted ${changedCount} Variable${changedCount === 1 ? "" : "s"}`,
  );
  const operationId = crypto.randomUUID();
  progress.start("Uploading");
  try {
    await synced.workflow.transport.begin({
      operationId,
      deviceId: synced.workflow.deviceId,
      kind: mutation === "ROLLBACK" ? "ROLLBACK" : "REVISION_PUBLICATION",
      commandBytes: artifacts.commandBytes,
      commandDigest: await sha384(artifacts.commandBytes),
    });
    for (const staged of artifacts.stagedObjects)
      await synced.workflow.transport.stage({
        operationId,
        deviceId: synced.workflow.deviceId,
        objectId: staged.objectId,
        bytes: staged.bytes,
      });
    await synced.workflow.transport.finalize({
      operationId,
      deviceId: synced.workflow.deviceId,
      request: artifacts.request,
    });
  } catch (error) {
    await synced.workflow.transport
      .cancel({ operationId, deviceId: synced.workflow.deviceId })
      .catch(() => undefined);
    progress.fail("Uploading");
    if (error instanceof CliError) throw error;
    const problem = error as { problem?: { code?: string } };
    const code = problem.problem?.code ?? "service_unavailable";
    const category = [
      "stale_head",
      "stale_epoch",
      "operation_conflict",
      "state_conflict",
      "genesis_exists",
    ].includes(code)
      ? "conflict"
      : [
            "invalid_crypto_object",
            "unsupported_media_type",
            "unsupported_crypto_suite",
          ].includes(code)
        ? "crypto"
        : "transient";
    throw new CliError(
      category,
      code === "stale_head"
        ? "the Environment changed after this publication was reconciled. Nothing further was published. Run the command again to reconcile from the recorded baseline."
        : category === "conflict"
          ? "the publication conflicts with current Server Profile state"
          : `the Server Profile could not publish the Revision (${code})`,
      {},
      code,
    );
  }
  progress.done("Uploaded");
  if (!options.noInput && !parsed.json)
    stepDone(
      mutation === "ROLLBACK"
        ? "Rollback published"
        : `Published ${changedCount} Variable${changedCount === 1 ? "" : "s"}`,
    );
  return {
    revision: artifacts.request.revision.id,
    lanes: artifacts.encryptedLaneCount,
    tombstones: artifacts.tombstoneLaneCount,
    message: mutation === "ROLLBACK" ? "Rollback published" : "Published",
    ...pendingActionsField(synced.workflow.pendingActions),
  };
};

export const shareEnvironmentWithPeerDevices = async (
  synced: Awaited<ReturnType<typeof syncWorkflow>>,
): Promise<void> => {
  const epochKey = synced.workflow.publicationContext.sharedValueSecret;
  if (
    !epochKey ||
    synced.workflow.boundary.peerDevices.length === 0 ||
    synced.variables.filter((variable) => !variable.tombstone).length === 0
  )
    return;
  const probe = await generateEncryptionKeyPair();
  try {
    await decodeSyncVariables(
      synced.page,
      () => probe.privateKey,
      [],
      epochKey,
    );
    return;
  } catch {
    // Shared Values are still sealed to this Device. Republish them with the
    // Project epoch key so other Devices can read them.
  }
  const context: PublicationContext = {
    ...synced.workflow.publicationContext,
    expectedHeadId: synced.page.currentHeadId,
    expectedHeadHash: synced.page.currentHeadHash,
    projectEpoch: safeProjectEpoch(synced.page.projectEpoch),
    mutation: synced.page.currentHeadId ? "MANIFEST_UPDATE" : "GENESIS",
  };
  const draft = synced.variables.map((variable) =>
    Object.freeze({
      ...variable,
      hasDraftChange: true,
    }),
  );
  const artifacts = await createPublicationArtifacts(draft, context);
  assertPublicationAccepted(reviewPublication(artifacts.commandBytes));
  const operationId = crypto.randomUUID();
  const deviceId = synced.workflow.deviceId;
  try {
    await synced.workflow.transport.begin({
      operationId,
      deviceId,
      kind: "REVISION_PUBLICATION",
      commandBytes: artifacts.commandBytes,
      commandDigest: await sha384(artifacts.commandBytes),
    });
    for (const staged of artifacts.stagedObjects)
      await synced.workflow.transport.stage({
        operationId,
        deviceId,
        objectId: staged.objectId,
        bytes: staged.bytes,
      });
    await synced.workflow.transport.finalize({
      operationId,
      deviceId,
      request: artifacts.request,
    });
  } catch (error) {
    await synced.workflow.transport
      .cancel({ operationId, deviceId })
      .catch(() => undefined);
    throw error instanceof CliError
      ? error
      : new CliError(
          "transient",
          "could not share this Environment with your other Devices",
          {},
          "peer_share_failed",
        );
  }
};

export const ownershipByName = (
  variables: readonly DecodedVariable[],
): ReadonlyMap<string, ValueOwnership> => {
  const ownership = new Map<string, ValueOwnership>();
  for (const variable of variables) {
    if (variable.tombstone) continue;
    ownership.set(
      variable.name,
      classificationFromOwnership(variable.ownership),
    );
  }
  return ownership;
};

export const withOwnership = (
  changes: readonly DotenvDiffChange[],
  variables: readonly DecodedVariable[],
): readonly DotenvDiffChange[] => {
  const known = ownershipByName(variables);
  return Object.freeze(
    changes.map((change) => {
      const value = known.get(change.name);
      return value ? Object.freeze({ ...change, ownership: value }) : change;
    }),
  );
};

export const trackedPullOutputDetail = (outputPath: string): string =>
  [
    `${outputPath} is tracked by Git; the next git add/commit could publish the decrypted Values written to it.`,
    "Choose one before re-running pull:",
    `  1. Untrack it (keeps your local file): git rm --cached ${outputPath}`,
    "  2. Pull to a different path: dotrelay pull --output <path>",
    "DotRelay never changes Git history or removes tracked content on your behalf.",
  ].join("\n");

export const guardPullOutputAgainstGit = async (
  options: WorkflowOptions,
  outputPath: string,
): Promise<"established" | "present" | undefined> => {
  const probe = options.gitTracking ?? createGitTrackingProbe();
  // The recoverable copy contains just as much plaintext as the output.
  // Check both before changing either file, including a previously tracked
  // backup which an ignore pattern cannot protect.
  const paths = [outputPath, `${outputPath}.previous`];
  const tracking = await Promise.all(paths.map((path) => probe(resolve(path))));
  for (const [index, info] of tracking.entries()) {
    if (info.state === "tracked")
      throw new CliError(
        "conflict",
        trackedPullOutputDetail(paths[index] ?? outputPath),
        {},
        "output_tracked",
      );
  }
  let result: "established" | "present" | undefined;
  for (const info of tracking) {
    if (info.state === "untracked") {
      const exclusion = await ensureLocalGitExclusion(info);
      if (result !== "established") result = exclusion;
    } else if (info.state === "ignored" && result === undefined) {
      result = "present";
    }
  }
  return result;
};

export const localPullChanges = async (
  outputPath: string,
  incoming: readonly DotenvEntry[],
  variables: readonly DecodedVariable[],
): Promise<readonly PublicationChange[] | null> => {
  let source: string;
  try {
    source = await readFile(outputPath, "utf8");
  } catch {
    return null;
  }
  try {
    return valueDiffsForPull(
      withOwnership(
        diffDotenvEntries(parseDotenv(source), incoming),
        variables,
      ),
    );
  } catch {
    return null;
  }
};

export const pendingActionsField = (
  actions: readonly string[],
): Readonly<Record<string, unknown>> =>
  actions.length > 0 ? { pendingActions: actions } : {};

// References a human or script can use instead of scraping internal ids:
// a Variable name (resolved against the live Manifest), a Variable id, a
// Revision id, or the ordinal the human history assigns to a Revision.
const UUID_REFERENCE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDINAL_REFERENCE = /^(?:#)?(\d+)$/;

export const resolveRollbackTarget = (
  reference: string,
  page: SyncPageWire,
): string => {
  const trimmed = reference.trim();
  const ordinal = ORDINAL_REFERENCE.exec(trimmed);
  if (ordinal?.[1]) {
    const revision = page.revisions[Number.parseInt(ordinal[1], 10) - 1];
    if (!revision)
      throw new CliInvocationError(
        `Revision ${trimmed} is not in the verified history; this Environment holds ${page.revisions.length} Revision${page.revisions.length === 1 ? "" : "s"}`,
      );
    return revision.id;
  }
  if (UUID_REFERENCE.test(trimmed)) return trimmed;
  throw new CliInvocationError(
    `Rollback target ${trimmed} must be a Revision id or the ordinal dotrelay history shows for it`,
  );
};

export const resolveVariableReferences = (
  references: readonly string[],
  variables: readonly DecodedVariable[],
): readonly string[] => {
  const live = variables.filter((variable) => !variable.tombstone);
  const liveNames = [...new Set(live.map((variable) => variable.name))].sort();
  const ids: string[] = [];
  for (const reference of references) {
    const trimmed = reference.trim();
    if (UUID_REFERENCE.test(trimmed)) {
      if (
        !live.some(
          (variable) => variable.id.toLowerCase() === trimmed.toLowerCase(),
        )
      )
        throw new CliInvocationError(
          `rollback Variable ${trimmed} is not part of the live Manifest`,
        );
      ids.push(trimmed.toLowerCase());
    } else {
      const matches = live.filter((variable) => variable.name === trimmed);
      if (matches.length === 0)
        throw new CliInvocationError(
          `unknown Variable ${trimmed}; the live Manifest holds ${liveNames.join(", ") || "no Variables"}`,
        );
      for (const variable of matches) ids.push(variable.id);
    }
  }
  return Object.freeze([...new Set(ids)]);
};
