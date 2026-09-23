import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertPublicationAccepted,
  createPublicationArtifacts,
  type DecodedVariable,
  decodeSyncVariables,
  type PublicationContext,
  reviewPublication,
  type SyncPageWire,
} from "@dotrelay/client";
import { generateEncryptionKeyPair, sha384 } from "@dotrelay/contracts";
import { listEnvironments, listTeams } from "./admin";
import type { ParsedArguments } from "./args";
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
        Object.freeze({ ...variable, value: null, tombstone: true }),
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

export const publish = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
  variables: readonly DecodedVariable[],
  mutation: "GENESIS" | "MANIFEST_UPDATE" | "ROLLBACK",
  rollback?: Readonly<{ target: string; ids: readonly string[] }>,
): Promise<Record<string, unknown>> => {
  const synced = await syncWorkflow(options, parsed);
  const context: PublicationContext = {
    ...synced.workflow.publicationContext,
    expectedHeadId: synced.page.currentHeadId,
    expectedHeadHash: synced.page.currentHeadHash,
    projectEpoch: safeProjectEpoch(synced.page.projectEpoch),
    mutation,
    ...(rollback
      ? {
          rollbackTargetId: rollback.target,
          rollbackSelectedVariableIds: rollback.ids,
        }
      : {}),
  };
  const draftVariables = variables.map((variable) =>
    toPublicationVariable(variable, synced.variables),
  );
  if (!draftVariables.some((variable) => variable.hasDraftChange))
    return {
      revision: synced.page.currentHeadId,
      lanes: 0,
      tombstones: 0,
      message: "Already published",
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
      category === "conflict"
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
  const tracking = await probe(resolve(outputPath));
  if (tracking.state === "tracked")
    throw new CliError(
      "conflict",
      trackedPullOutputDetail(outputPath),
      {},
      "output_tracked",
    );
  if (tracking.state === "untracked") return ensureLocalGitExclusion(tracking);
  if (tracking.state === "ignored") return "present";
  return undefined;
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
