import type { DotenvEntry } from "./dotenv";
import {
  canActorChangeDefinitions,
  canActorChangeVariableValue,
  createEnvironmentVariable,
  type EditorActor,
  type EnvironmentVariable,
  updateVariableValue,
  type VariableOwnership,
  validateVariableDraft,
  variableHasDraftChange,
} from "./environment-workflow";

// Turns pasted .env entries into a reviewable plan against the editor's
// current draft, then stages the plan into that draft. Nothing here
// publishes: the staged changes go through the usual review and publish.

export type DotenvImportAction =
  | Readonly<{ readonly kind: "add"; readonly name: string; value: string }>
  | Readonly<{
      readonly kind: "update";
      readonly name: string;
      readonly value: string;
      readonly variableId: string;
    }>
  | Readonly<{ readonly kind: "unchanged"; readonly name: string }>
  | Readonly<{
      readonly kind: "blocked";
      readonly name: string;
      readonly reason: string;
    }>;

export const planDotenvImport = (
  entries: readonly DotenvEntry[],
  variables: readonly EnvironmentVariable[],
  actor: EditorActor,
): readonly DotenvImportAction[] =>
  entries.map((entry): DotenvImportAction => {
    const live = variables.find(
      (variable) => !variable.tombstone && variable.name === entry.name,
    );
    if (live) {
      if (live.value === entry.value)
        return { kind: "unchanged", name: entry.name };
      if (!canActorChangeVariableValue(actor, live))
        return {
          kind: "blocked",
          name: entry.name,
          reason: "You can't change this value with your role.",
        };
      try {
        updateVariableValue(live, entry.value);
      } catch (error) {
        return {
          kind: "blocked",
          name: entry.name,
          reason:
            error instanceof Error ? error.message : "This value is invalid.",
        };
      }
      return {
        kind: "update",
        name: entry.name,
        value: entry.value,
        variableId: live.id,
      };
    }
    if (variables.some((variable) => variable.name === entry.name))
      return {
        kind: "blocked",
        name: entry.name,
        reason:
          "It's marked for deletion in your draft. Undo the delete first.",
      };
    if (!canActorChangeDefinitions(actor))
      return {
        kind: "blocked",
        name: entry.name,
        reason: "Only owners and admins can add variables.",
      };
    const invalid = validateVariableDraft(
      {
        name: entry.name,
        description: "",
        ownership: "SHARED_VALUE",
        value: entry.value,
        required: true,
      },
      variables,
    );
    if (invalid) return { kind: "blocked", name: entry.name, reason: invalid };
    return { kind: "add", name: entry.name, value: entry.value };
  });

export const applyDotenvImport = (
  plan: readonly DotenvImportAction[],
  variables: readonly EnvironmentVariable[],
  options: Readonly<{
    readonly ownership: VariableOwnership;
    readonly actorUserId: string | null;
    readonly baselineFor: (id: string) => EnvironmentVariable | undefined;
    readonly nextId: () => string;
  }>,
): EnvironmentVariable[] => {
  const updates = new Map<string, string>();
  for (const action of plan)
    if (action.kind === "update") updates.set(action.variableId, action.value);
  const updated = variables.map((variable) => {
    const value = updates.get(variable.id);
    if (value === undefined) return variable;
    const next = updateVariableValue(variable, value);
    return Object.freeze({
      ...next,
      hasDraftChange: variableHasDraftChange(
        next,
        options.baselineFor(variable.id),
      ),
    });
  });
  const added = plan.flatMap((action) =>
    action.kind === "add"
      ? [
          createEnvironmentVariable(
            {
              name: action.name,
              description: "",
              ownership: options.ownership,
              value: action.value,
              required: true,
            },
            options.nextId(),
            { actorUserId: options.actorUserId },
          ),
        ]
      : [],
  );
  return [...updated, ...added];
};
