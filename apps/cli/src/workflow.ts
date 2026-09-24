import { readFile, stat } from "node:fs/promises";
import type { ParsedArguments } from "./args";
import { kv, reviewFrame } from "./components";
import { diffDotenvEntries, parseDotenv, serializeDotenv } from "./dotenv";
import { CliError, CliInvocationError, sanitizeCliText } from "./errors";
import { assertSafeStdout, atomicWriteProtectedFile } from "./output";
import { pad, visibleWidth } from "./theme";
import { isUnreadableTerminalError, paint } from "./ui";
import {
  destinationRows,
  pullConfirmQuestion,
  renderEnvDiff,
  reviewBody,
} from "./value-diff";
import type { WorkflowOptions } from "./workflow-core";
import { renderSyncedHistory } from "./workflow-history";
import {
  classificationFromOwnership,
  classify,
  destinationFor,
  guardPullOutputAgainstGit,
  localPullChanges,
  pendingActionsField,
  publish,
  resolveRollbackTarget,
  resolveVariableReferences,
  shareEnvironmentWithPeerDevices,
  variablesFromDotenv,
  withOwnership,
} from "./workflow-publication";
import { syncWorkflow } from "./workflow-session";

export {
  createRecoveryCodeBackup,
  recoverAccountKey,
  revokeAccountKeyWrapper,
  setupDeviceAccountKey,
  transferAccountKey,
} from "./workflow-account-key";
export { workspaceBoundaryFields } from "./workflow-core";
export {
  approveDeviceEnrollment,
  beginDeviceEnrollment,
  completeDeviceEnrollment,
  enrollDevice,
  enrollFirstDevice,
} from "./workflow-device-enrollment";

import { ask, confirmSilent } from "./workflow-core";
export const runProtectedWorkflow = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<Record<string, unknown> | { stdout: string }> => {
  if (parsed.command === "history") {
    const synced = await syncWorkflow(options, parsed);
    if (!parsed.json) return { stdout: renderSyncedHistory(synced) };
    return {
      revisions: synced.page.revisions.map((revision) => ({
        id: revision.id,
        mutation: revision.mutation,
        projectEpoch: revision.projectEpoch.toString(),
        authoredAtMs: revision.authoredAtMs.toString(),
        rollbackTargetId: revision.rollbackTargetId,
      })),
      ...pendingActionsField(synced.workflow.pendingActions),
    };
  }
  if (parsed.command === "diff") {
    const inputPath = parsed.from ?? ".env";
    let source: string;
    try {
      source = await readFile(inputPath, "utf8");
    } catch {
      throw new CliError(
        "local-io",
        "could not read the dotenv input file",
        {},
        "input_read_failed",
      );
    }
    const local = parseDotenv(source);
    const synced = await syncWorkflow(options, parsed);
    const missing = synced.variables.filter(
      (variable) => !variable.tombstone && variable.value === null,
    );
    if (missing.length > 0)
      throw new CliError(
        "incomplete-export",
        "the Environment has Values that are not available on this Device",
        { missingCount: missing.length },
        "missing_values",
      );
    const remote = synced.variables
      .filter((variable) => !variable.tombstone)
      .map((variable) =>
        Object.freeze({ name: variable.name, value: variable.value ?? "" }),
      );
    const changes = withOwnership(
      diffDotenvEntries(local, remote),
      synced.variables,
    );
    const added = Object.freeze(
      changes
        .filter((change) => change.kind === "added")
        .map((change) => change.name),
    );
    const updated = Object.freeze(
      changes
        .filter((change) => change.kind === "updated")
        .map((change) => change.name),
    );
    const removed = Object.freeze(
      changes
        .filter((change) => change.kind === "removed")
        .map((change) => change.name),
    );
    const unchangedCount =
      local.length -
      changes.filter(
        (change) => change.kind === "added" || change.kind === "updated",
      ).length;
    if (parsed.json)
      return {
        added,
        updated,
        removed,
        unchangedCount,
        ...pendingActionsField(synced.workflow.pendingActions),
      };
    return { stdout: renderEnvDiff(changes, parsed.reveal) };
  }
  if (parsed.command === "pull") {
    const outputPath = parsed.stdout ? undefined : (parsed.output ?? ".env");
    if (!outputPath && !parsed.stdout)
      throw new CliInvocationError("pull requires --output <file> or --stdout");
    // Check Git exposure before any Value is decrypted or moved: a tracked
    // output is refused up front and an untracked one gets a repository-local
    // exclusion so a later git add cannot pick the plaintext file up.
    let gitExclusion: "established" | "present" | undefined;
    if (outputPath)
      gitExclusion = await guardPullOutputAgainstGit(options, outputPath);
    const synced = await syncWorkflow(options, parsed);
    const missing = synced.variables.filter(
      (variable) => !variable.tombstone && variable.value === null,
    );
    if (missing.length > 0)
      throw new CliError(
        "incomplete-export",
        "the Environment has Values that are not available on this Device",
        { missingCount: missing.length },
        "missing_values",
      );
    await shareEnvironmentWithPeerDevices(synced);
    const entries = synced.variables
      .filter((variable) => !variable.tombstone)
      .map((variable) => ({
        name: variable.name,
        value: variable.value ?? "",
      }));
    const contents = serializeDotenv(entries);
    if (parsed.stdout && parsed.reveal && !options.noInput) {
      const destination = await destinationFor(
        options,
        synced.workflow.publicationContext,
      );
      const question = `Reveal ${entries.length} decrypted Values to stdout? [y/N]`;
      const frame = reviewFrame({
        title: `Review — reveal values to stdout`,
        danger: true,
        body: [
          kv(destinationRows(destination), 14),
          `  ${paint(
            "The decrypted Values will be printed to this terminal.",
            "faint",
          )}`,
        ].join("\n"),
        question,
      });
      (options.terminal?.output ?? process.stderr).write(`${frame}\n`);
      if (!(await confirmSilent(options, question)))
        throw new CliInvocationError("Value reveal confirmation was declined");
    }
    let replaceExisting = false;
    if (outputPath) {
      let existingFile = false;
      try {
        existingFile = (await stat(outputPath)).isFile();
      } catch {
        existingFile = false;
      }
      if (existingFile) {
        const changes = await localPullChanges(
          outputPath,
          entries,
          synced.variables,
        );
        if (changes !== null && changes.length === 0)
          return {
            output: outputPath,
            unchanged: true,
            ...(gitExclusion ? { gitExclusion } : {}),
            ...pendingActionsField(synced.workflow.pendingActions),
            message: "No changes found",
          };
        if (options.noInput) {
          if (!options.force)
            throw new CliError(
              "conflict",
              `${outputPath} differs from the Environment and was retained; re-run with --force to replace it`,
              changes !== null ? { changedCount: changes.length } : {},
              "output_conflict",
            );
        } else {
          const destination = await destinationFor(
            options,
            synced.workflow.publicationContext,
          );
          const question = pullConfirmQuestion(outputPath);
          const frame = reviewFrame({
            title: `Review — replace ${outputPath}`,
            danger: true,
            body: reviewBody(changes, destination, parsed.reveal, [
              `  ${paint(
                `The current file is retained at ${outputPath}.previous`,
                "faint",
              )}`,
            ]),
            question,
          });
          (options.terminal?.output ?? process.stderr).write(`${frame}\n`);
          if (!(await confirmSilent(options, question)))
            throw new CliInvocationError("pull confirmation was declined");
        }
        replaceExisting = true;
      }
    }
    assertSafeStdout({
      requested: parsed.stdout,
      terminal: options.stdoutIsTerminal,
      reveal: parsed.reveal,
    });
    if (outputPath)
      await atomicWriteProtectedFile(outputPath, contents, {
        ...(replaceExisting ? { retainPrevious: true } : {}),
      });
    const exclusionNote =
      gitExclusion === "established"
        ? `; ${outputPath} is excluded from Git via .git/info/exclude so it will not be tracked`
        : "";
    return parsed.stdout
      ? {
          stdout: contents,
          ...pendingActionsField(synced.workflow.pendingActions),
        }
      : {
          output: outputPath ?? "",
          ...(gitExclusion ? { gitExclusion } : {}),
          ...(replaceExisting ? { previous: `${outputPath}.previous` } : {}),
          ...pendingActionsField(synced.workflow.pendingActions),
          message: replaceExisting
            ? `Wrote ${entries.length} values to ${outputPath}; prior file retained at ${outputPath}.previous${exclusionNote}`
            : `Wrote ${entries.length} values to ${outputPath}${exclusionNote}`,
        };
  }
  if (parsed.command === "init" || parsed.command === "push") {
    const inputPath = parsed.from ?? ".env";
    let source: string;
    try {
      source = await readFile(inputPath, "utf8");
    } catch {
      throw new CliError(
        "local-io",
        "could not read the dotenv input file",
        {},
        "input_read_failed",
      );
    }
    const synced = await syncWorkflow(options, parsed);
    const empty = synced.page.currentHeadId === null;
    const existing = synced.variables;
    const entries = await classify(
      options,
      parsed,
      parseDotenv(source),
      existing,
    );
    const variables = variablesFromDotenv(entries, existing);
    const result = await publish(
      options,
      parsed,
      variables,
      empty ? "GENESIS" : "MANIFEST_UPDATE",
    );
    // The worktree selection is persisted only after a successful
    // publication, so the Environment created by init is reused by later
    // invocations instead of a second one being created.
    if (parsed.command === "init" && synced.workflow.createdEnvironmentId) {
      const { readStoredWorktreeContext, writeWorktreeContext } = await import(
        "./context"
      );
      // Preserve the explicit repository choice recorded for this worktree;
      // the selection was made against the current Git remotes before the
      // workflow started.
      const recorded = await readStoredWorktreeContext(options.contextPath);
      await writeWorktreeContext(options.contextPath, {
        ...(recorded ?? {}),
        serverProfileId: synced.workflow.publicationContext.serverProfileId,
        projectId: synced.workflow.publicationContext.projectId,
        environmentId: synced.workflow.createdEnvironmentId,
      });
    }
    return result;
  }
  if (parsed.command === "rollback") {
    const synced = await syncWorkflow(options, parsed);
    const terminalOutput = options.terminal?.output ?? process.stderr;
    // The target Revision comes from the command line or, interactively,
    // from the rendered history, so an operator never has to lift internal
    // ids out of a JSON dump; automation still passes them explicitly.
    let targetReference = (parsed.positionals[0] ?? "").trim();
    if (!targetReference && !options.noInput) {
      terminalOutput.write(renderSyncedHistory(synced));
      try {
        targetReference = (
          await ask(
            options,
            "Roll back to which Revision (ordinal, #ordinal, or Revision id)?",
          )
        ).trim();
      } catch (error) {
        // The prompt names only safe remedies: the Revision is an id or
        // ordinal, never a secret, so naming the positional is safe here
        // (unlike secret prompts, which must not suggest the command line).
        if (isUnreadableTerminalError(error))
          throw new CliInvocationError(
            "rollback needs a terminal to choose the target Revision; pass the Revision id or #ordinal positionally, or re-run with --no-input",
          );
        throw error;
      }
    }
    if (!targetReference)
      throw new CliInvocationError("rollback requires a target Revision");
    const target = resolveRollbackTarget(targetReference, synced.page);
    const live = synced.variables.filter((variable) => !variable.tombstone);
    let references = parsed.variableReferences;
    if (references.length === 0 && !options.noInput) {
      const maxName = live.reduce(
        (width, variable) =>
          Math.max(width, visibleWidth(sanitizeCliText(variable.name))),
        0,
      );
      terminalOutput.write(
        [
          paint("Variables in the live Manifest:", "fg"),
          ...live.map(
            (variable) =>
              `  ${pad(sanitizeCliText(variable.name), maxName)}  ${paint(
                classificationFromOwnership(variable.ownership),
                "muted",
              )}`,
          ),
          "",
        ].join("\n"),
      );
      const answer = await (async () => {
        try {
          return (
            await ask(
              options,
              'Variables to roll back (comma-separated names, or "all")?',
            )
          ).trim();
        } catch (error) {
          // Variable names are operator-visible, never secrets, so naming
          // the flag is safe here.
          if (isUnreadableTerminalError(error))
            throw new CliInvocationError(
              "rollback needs a terminal to choose Variables; pass at least one --variable <variable-name-or-id>, or re-run with --no-input",
            );
          throw error;
        }
      })();
      references =
        answer === "all"
          ? live.map((variable) => variable.name)
          : answer
              .split(",")
              .map((name) => name.trim())
              .filter((name) => name.length > 0);
      // An answer of only separators names no Variable; refuse it instead
      // of silently publishing nothing.
      if (references.length === 0)
        throw new CliInvocationError("rollback requires at least one Variable");
    }
    const selectedIds = resolveVariableReferences(references, synced.variables);
    const selected = new Set(selectedIds);
    let targetValues: ReadonlyMap<string, string | null>;
    try {
      targetValues = await synced.workflow.session.resolveRollbackValues({
        targetRevision: target,
        selectedVariableIds: selectedIds,
      });
    } catch {
      throw new CliError(
        "conflict",
        "the target Revision is not available in verified history",
        {},
        "rollback_target_unavailable",
      );
    }
    const absentSelected = selectedIds.filter(
      (variableId) => !targetValues.has(variableId),
    );
    if (absentSelected.length > 0) {
      const names = absentSelected
        .map((variableId) => {
          const candidate = synced.variables.find(
            (variable) => variable.id === variableId,
          );
          return candidate ? candidate.name : variableId;
        })
        .join(", ");
      throw new CliError(
        "conflict",
        `${names} did not exist in the target Revision and cannot be rolled back`,
        {},
        "rollback_variable_absent",
      );
    }
    const variables = synced.variables.map((variable) =>
      selected.has(variable.id)
        ? Object.freeze({
            ...variable,
            value: targetValues.get(variable.id) ?? null,
          })
        : variable,
    );
    return publish(options, parsed, variables, "ROLLBACK", {
      target,
      ids: selectedIds,
    });
  }
  throw new CliInvocationError(
    "the protected workflow is not available for this command",
  );
};
