import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ParsedArguments } from "./args";
import { writePublicationBaseline } from "./baseline-store";
import { kv, note, reviewFrame } from "./components";
import {
  diffDotenvEntries,
  literalDotenvNames,
  parseDotenv,
  serializeDotenv,
} from "./dotenv";
import { processControlPullWarning } from "./env-safety";
import {
  CliError,
  CliInvocationError,
  sanitizeCliLine,
  sanitizeCliText,
} from "./errors";
import {
  assertSafeStdout,
  atomicWriteProtectedFile,
  resolveOutputTarget,
} from "./output";
import {
  classifyPullValues,
  othersPrivateNote,
  pullVariableNames,
} from "./pull-values";
import { pad, visibleWidth } from "./theme";
import { isUnreadableTerminalError, paint, readTerminalSecret } from "./ui";
import {
  destinationRows,
  pullConfirmQuestion,
  pullReplacementNotes,
  renderEnvDiff,
  reviewBody,
} from "./value-diff";
import {
  ask,
  bytesToHex,
  confirmSilent,
  createDeviceAdmin,
  type WorkflowOptions,
} from "./workflow-core";
import { type HistoryAuthors, renderSyncedHistory } from "./workflow-history";
import {
  classificationFromOwnership,
  classify,
  destinationFor,
  guardPullOutputAgainstGit,
  localPullChanges,
  pendingActionsField,
  preparePublicationBaseline,
  publish,
  resolveRollbackTarget,
  resolveVariableReferences,
  shareEnvironmentWithPeerDevices,
  trackedInputWarning,
  unpushedLocalChanges,
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

// The dotenv file push, init and diff read; a missing file names the path
// and the way to point the command at another one.
const readDotenvInput = async (inputPath: string): Promise<string> => {
  try {
    return await readFile(inputPath, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new CliError(
      "local-io",
      missing
        ? `couldn't read ${inputPath} because it doesn't exist. Create it, or pass --from <file> to use another file.`
        : `couldn't read ${inputPath}. Check that it's a readable file, or pass --from <file> to use another file.`,
      {},
      "input_read_failed",
    );
  }
};

// Member names for "by <name>" in history. A failed lookup only drops the
// names; the verified history still renders.
const historyAuthors = async (
  options: WorkflowOptions,
  synced: Awaited<ReturnType<typeof syncWorkflow>>,
): Promise<HistoryAuthors> => {
  const { actorUserId, teamId } = synced.workflow.publicationContext;
  const names = new Map<string, string>();
  if (teamId)
    try {
      const listed = await createDeviceAdmin(
        options,
        synced.workflow.deviceId,
      ).get(`/api/v1/teams/${encodeURIComponent(teamId)}/memberships`, [
        "memberships",
        "invitations",
      ]);
      for (const entry of Array.isArray(listed.memberships)
        ? listed.memberships
        : [])
        if (
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.userId === "string" &&
          typeof entry.name === "string"
        )
          names.set(entry.userId, entry.name);
    } catch {
      // Names are a nicety; the history itself is already verified.
    }
  return { actorUserId, names };
};

export const runProtectedWorkflow = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<Record<string, unknown> | { stdout: string }> => {
  if (parsed.command === "history") {
    const synced = await syncWorkflow(options, parsed);
    if (!parsed.json) {
      const { environment } = await destinationFor(
        options,
        synced.workflow.publicationContext,
        synced.workflow.deviceId,
      );
      return {
        stdout: renderSyncedHistory(
          synced,
          environment,
          await historyAuthors(options, synced),
        ),
      };
    }
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
    const local = parseDotenv(await readDotenvInput(inputPath), inputPath);
    const synced = await syncWorkflow(options, parsed);
    const groups = classifyPullValues(
      synced.variables,
      synced.workflow.publicationContext.actorUserId,
    );
    if (groups.unreadable.length > 0 || groups.requiredMissing.length > 0) {
      const blocking =
        groups.unreadable.length > 0
          ? groups.unreadable
          : groups.requiredMissing;
      const names = pullVariableNames(blocking);
      throw new CliError(
        "incomplete-export",
        groups.unreadable.length > 0
          ? `${names} can't be decrypted on this device. Run dotrelay device recover, or ask a team owner or admin to choose "Share project keys" for you in the web app (Members view). Then try again.`
          : `${names} are required but have no value. Add them with dotrelay push, or run dotrelay pull to enter them.`,
        { missingCount: blocking.length, variableNames: names.slice(0, 512) },
        "missing_values",
      );
    }
    const remote = groups.present.map((variable) =>
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
    const optionalOmitted = groups.optionalAbsent.length;
    if (parsed.json)
      return {
        added,
        updated,
        removed,
        unchangedCount,
        ...(optionalOmitted > 0 ? { optionalOmitted } : {}),
        ...pendingActionsField(synced.workflow.pendingActions),
      };
    const privateNote = othersPrivateNote(groups.othersPrivate);
    const omission = `${
      optionalOmitted > 0
        ? `\n${optionalOmitted} optional ${optionalOmitted === 1 ? "variable has no value and was" : "variables have no value and were"} left out\n`
        : ""
    }${privateNote ? `\n${privateNote}\n` : ""}`;
    return { stdout: `${renderEnvDiff(changes, parsed.reveal)}${omission}` };
  }
  if (parsed.command === "pull") {
    const outputPath = parsed.stdout ? undefined : (parsed.output ?? ".env");
    if (!outputPath && !parsed.stdout)
      throw new CliInvocationError("pull needs --output <file> or --stdout");
    // Check Git exposure before any Value is decrypted or moved: a tracked
    // output is refused up front and an untracked one gets a repository-local
    // exclusion so a later git add cannot pick the plaintext file up.
    let gitExclusion: "established" | "present" | undefined;
    if (outputPath)
      gitExclusion = await guardPullOutputAgainstGit(options, outputPath);
    // A symlinked output is written through to the file it names; the
    // review and the report name that file so the write is never a surprise.
    const linkedTarget = outputPath
      ? await resolveOutputTarget(outputPath)
          .then((target) =>
            target === outputPath || target === resolve(outputPath)
              ? undefined
              : target,
          )
          .catch(() => undefined)
      : undefined;
    const linkNote = linkedTarget
      ? ` (a symlink to ${sanitizeCliLine(linkedTarget)})`
      : "";
    const synced = await syncWorkflow(options, parsed);
    const groups = classifyPullValues(
      synced.variables,
      synced.workflow.publicationContext.actorUserId,
    );
    if (groups.unreadable.length > 0) {
      const names = pullVariableNames(groups.unreadable);
      throw new CliError(
        "incomplete-export",
        `${names} can't be decrypted on this device. Nothing was written. Run dotrelay device recover, or ask a team owner or admin to choose "Share project keys" for you in the web app (Members view). Then pull again.`,
        {
          missingCount: groups.unreadable.length,
          variableNames: names.slice(0, 512),
        },
        "missing_values",
      );
    }
    const supplied = new Map<string, string>();
    if (groups.requiredMissing.length > 0) {
      const names = pullVariableNames(groups.requiredMissing);
      if (options.noInput)
        throw new CliError(
          "incomplete-export",
          `${names} are required but have no value. Nothing was written. Add them to a dotenv file and run dotrelay push, or run pull again without --no-input to enter them.`,
          {
            missingCount: groups.requiredMissing.length,
            variableNames: names.slice(0, 512),
          },
          "missing_values",
        );
      (options.terminal?.output ?? process.stderr).write(
        `${note(
          `${names} are required but have no value. Enter each one. What you type stays hidden.`,
        )}\n`,
      );
      for (const variable of groups.requiredMissing) {
        supplied.set(
          variable.name,
          await readTerminalSecret(
            `Value for ${sanitizeCliLine(variable.name)}`,
            {
              ...(options.terminal ? { terminal: options.terminal } : {}),
              ...(options.prompt ? { prompt: options.prompt } : {}),
              noInput: options.noInput,
            },
          ),
        );
      }
    }
    await shareEnvironmentWithPeerDevices(synced);
    const entries = [
      ...groups.present.map((variable) => ({
        name: variable.name,
        value: variable.value ?? "",
      })),
      ...groups.requiredMissing.map((variable) => ({
        name: variable.name,
        value: supplied.get(variable.name) ?? "",
      })),
    ];
    const optionalOmitted = groups.optionalAbsent.length;
    const privateNote = othersPrivateNote(groups.othersPrivate);
    const omissionNote = `${
      optionalOmitted > 0
        ? `; ${optionalOmitted} optional ${optionalOmitted === 1 ? "variable has no value and was" : "variables have no value and were"} left out`
        : ""
    }${privateNote ? `. ${privateNote}` : ""}`;
    const rememberBaseline = async (): Promise<void> => {
      if (!outputPath) return;
      const hash = synced.page.currentHeadHash ?? new Uint8Array(48);
      await writePublicationBaseline(options.stateDirectory, {
        environmentId: synced.page.environmentId,
        inputPath: outputPath,
        revisionId: synced.page.currentHeadId ?? synced.page.environmentId,
        headHash: bytesToHex(hash),
      });
    };
    // The file being replaced decides two things: a Value it single-quoted
    // was meant literally and stays single-quoted, and a Variable that
    // controls how programs or shells start is inert in the file but not
    // once the file is loaded into a shell, so one new to the destination
    // is called out for the user to check who published it.
    const previousNames = new Set<string>();
    let literalNames: ReadonlySet<string> = new Set();
    if (outputPath)
      try {
        const previous = await readFile(outputPath, "utf8");
        for (const entry of parseDotenv(previous))
          previousNames.add(entry.name);
        literalNames = literalDotenvNames(previous);
      } catch {
        // No readable previous file: every entry is new.
      }
    const contents = serializeDotenv(entries, { literalNames });
    const processControlWarning = processControlPullWarning(
      entries
        .map((entry) => entry.name)
        .filter((name) => !previousNames.has(name)),
    );
    if (processControlWarning && !parsed.json)
      (options.terminal?.output ?? process.stderr).write(
        `${note(processControlWarning, "warn")}\n`,
      );
    const warningsField = processControlWarning
      ? { warnings: [processControlWarning] }
      : {};
    if (parsed.stdout && parsed.reveal && !options.noInput) {
      const destination = await destinationFor(
        options,
        synced.workflow.publicationContext,
        synced.workflow.deviceId,
      );
      const question = `Print ${entries.length} decrypted values to this terminal? [y/N]`;
      const frame = reviewFrame({
        title: "Print decrypted values to this terminal",
        danger: true,
        body: [
          kv(destinationRows(destination), 14),
          `  ${paint(
            "The decrypted values will be printed here in plain text.",
            "faint",
          )}`,
        ].join("\n"),
        question,
      });
      (options.terminal?.output ?? process.stderr).write(`${frame}\n`);
      if (!(await confirmSilent(options, question)))
        throw new CliInvocationError(
          "you didn't confirm, so no values were printed",
        );
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
        if (changes !== null && changes.length === 0) {
          await rememberBaseline();
          return {
            output: outputPath,
            unchanged: true,
            ...(parsed.json ? warningsField : {}),
            ...(optionalOmitted > 0 ? { optionalOmitted } : {}),
            ...(gitExclusion ? { gitExclusion } : {}),
            ...pendingActionsField(synced.workflow.pendingActions),
            message: `${outputPath} already matches the environment${omissionNote}`,
          };
        }
        const unpushed = await unpushedLocalChanges(
          options,
          synced,
          outputPath,
          entries,
        );
        const unpushedNames = (unpushed ?? [])
          .map((change) => change.name)
          .join(", ");
        if (options.noInput) {
          if (!options.force)
            throw new CliError(
              "conflict",
              `${outputPath} doesn't match the environment, so it was left as it is. Run pull again with --force to replace it.`,
              changes !== null ? { changedCount: changes.length } : {},
              "output_conflict",
            );
          // --force approves catching the file up, not losing work: edits
          // made since the last pull need their own explicit approval.
          if (unpushed && unpushed.length > 0 && !parsed.discardLocal)
            throw new CliError(
              "conflict",
              `${outputPath} has local changes you haven't pushed (${unpushedNames}), and this pull would overwrite them. Nothing was written. Run dotrelay push first, or run pull again with --force --discard-local to replace them.`,
              {
                changedCount: unpushed.length,
                variableNames: unpushedNames.slice(0, 512),
              },
              "output_conflict",
            );
        } else {
          const destination = await destinationFor(
            options,
            synced.workflow.publicationContext,
            synced.workflow.deviceId,
          );
          const question = pullConfirmQuestion(outputPath);
          const frame = reviewFrame({
            title: `Replace ${outputPath} with the environment's values`,
            danger: true,
            body: reviewBody(changes, destination, parsed.reveal, [
              ...pullReplacementNotes(outputPath, unpushed),
              ...(linkedTarget
                ? [
                    `  ${paint(
                      `${sanitizeCliLine(outputPath)} is a symlink, so this replaces ${sanitizeCliLine(linkedTarget)}`,
                      "warn",
                    )}`,
                  ]
                : []),
              `  ${paint(
                `The current file will be kept at ${outputPath}.previous`,
                "faint",
              )}`,
            ]),
            question,
          });
          (options.terminal?.output ?? process.stderr).write(`${frame}\n`);
          if (!(await confirmSilent(options, question)))
            throw new CliInvocationError(
              `you didn't confirm, so ${outputPath} wasn't changed`,
            );
        }
        replaceExisting = true;
      }
    }
    assertSafeStdout({
      requested: parsed.stdout,
      terminal: options.stdoutIsTerminal,
      reveal: parsed.reveal,
    });
    if (outputPath) {
      await atomicWriteProtectedFile(outputPath, contents, {
        ...(replaceExisting ? { retainPrevious: true } : {}),
        followSymlink: true,
      });
      await rememberBaseline();
    }
    const exclusionNote =
      gitExclusion === "established"
        ? `; ${outputPath} is listed in .git/info/exclude, so Git won't track it`
        : "";
    return parsed.stdout
      ? {
          stdout: contents,
          ...pendingActionsField(synced.workflow.pendingActions),
        }
      : {
          output: outputPath ?? "",
          ...(parsed.json ? warningsField : {}),
          ...(gitExclusion ? { gitExclusion } : {}),
          ...(replaceExisting ? { previous: `${outputPath}.previous` } : {}),
          ...(linkedTarget ? { target: linkedTarget } : {}),
          ...pendingActionsField(synced.workflow.pendingActions),
          ...(optionalOmitted > 0 ? { optionalOmitted } : {}),
          message: replaceExisting
            ? `Wrote ${entries.length} values to ${outputPath}${linkNote}; the old file is kept at ${outputPath}.previous${exclusionNote}${omissionNote}`
            : `Wrote ${entries.length} values to ${outputPath}${linkNote}${exclusionNote}${omissionNote}`,
        };
  }
  if (parsed.command === "init" || parsed.command === "push") {
    const inputPath = parsed.from ?? ".env";
    const local = parseDotenv(await readDotenvInput(inputPath), inputPath);
    const warnings: string[] = [];
    const tracked = await trackedInputWarning(options, inputPath);
    if (tracked) warnings.push(tracked);
    const synced = await syncWorkflow(options, parsed);
    const prepared = await preparePublicationBaseline(
      options,
      synced,
      inputPath,
    );
    if (prepared.notice) warnings.push(prepared.notice);
    if (!parsed.json)
      for (const warning of warnings)
        (options.terminal?.output ?? process.stderr).write(
          `${note(warning, "warn")}\n`,
        );
    // A name the Publication Baseline held keeps the baseline's id, so a
    // teammate's later deletion or replacement of that Variable reaches
    // reconciliation as such; classification and the ids of names the
    // baseline never held follow the Environment this invocation verified,
    // so a teammate's later addition is not treated as brand-new.
    const entries = await classify(options, parsed, local, [
      ...synced.variables,
      ...prepared.snapshot,
    ]);
    const variables = variablesFromDotenv(
      entries,
      synced.variables,
      prepared.snapshot,
    );
    const result = await publish(
      options,
      parsed,
      variables,
      synced.page.currentHeadId === null ? "GENESIS" : "MANIFEST_UPDATE",
      undefined,
      { ...prepared.reconciliation, draft: variables },
    );
    // The worktree selection is persisted only after a successful
    // publication, so the Environment created by init is reused by later
    // invocations instead of a second one being created.
    if (parsed.command === "init" && synced.workflow.createdEnvironmentId) {
      const { readStoredWorktreeContext, writeWorktreeContext } =
        await import("./context");
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
    return parsed.json && warnings.length > 0
      ? { ...result, warnings }
      : result;
  }
  if (parsed.command === "rollback") {
    const synced = await syncWorkflow(options, parsed);
    const terminalOutput = options.terminal?.output ?? process.stderr;
    // The target Revision comes from the command line or, interactively,
    // from the rendered history, so an operator never has to lift internal
    // ids out of a JSON dump; automation still passes them explicitly.
    let targetReference = (parsed.positionals[0] ?? "").trim();
    if (!targetReference && !options.noInput) {
      const { environment } = await destinationFor(
        options,
        synced.workflow.publicationContext,
        synced.workflow.deviceId,
      );
      terminalOutput.write(renderSyncedHistory(synced, environment));
      try {
        targetReference = (
          await ask(
            options,
            "Roll back to which revision? (number, #number or revision id)",
          )
        ).trim();
      } catch (error) {
        // The prompt names only safe remedies: the Revision is an id or
        // ordinal, never a secret, so naming the positional is safe here
        // (unlike secret prompts, which must not suggest the command line).
        if (isUnreadableTerminalError(error))
          throw new CliInvocationError(
            "rollback needs a terminal to pick the revision. Pass the revision id or #number as an argument, like dotrelay rollback #3, or run it again with --no-input.",
          );
        throw error;
      }
    }
    if (!targetReference)
      throw new CliInvocationError(
        "say which revision to roll back to, like dotrelay rollback #3",
      );
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
          paint("Variables in the current revision:", "fg"),
          ...live.map(
            (variable) =>
              `  ${pad(sanitizeCliText(variable.name), maxName)}  ${paint(
                classificationFromOwnership(variable.ownership) === "shared"
                  ? "Team"
                  : "Only me",
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
              'Which variables should roll back? (names separated by commas, or "all")',
            )
          ).trim();
        } catch (error) {
          // Variable names are operator-visible, never secrets, so naming
          // the flag is safe here.
          if (isUnreadableTerminalError(error))
            throw new CliInvocationError(
              "rollback needs a terminal to pick the variables. Pass at least one --variable <variable-name-or-id>, or run it again with --no-input.",
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
        throw new CliInvocationError("pick at least one variable to roll back");
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
        "that revision isn't in the verified history, so it can't be rolled back to",
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
        `${names} didn't exist in that revision, so they can't be rolled back`,
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
      values: targetValues,
    });
  }
  throw new CliInvocationError("this command has no encrypted workflow to run");
};
