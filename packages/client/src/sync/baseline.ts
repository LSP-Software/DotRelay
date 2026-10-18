import type { SyncPageWire } from "@dotrelay/contracts";
import {
  changedVariableIdsFromRevision,
  type DecodedVariable,
} from "./publication";

export type BaselineResolution = "local" | "remote" | "merge";

export type BaselineConflictKind = "definition" | "deletion" | "name" | "value";

export type BaselineConflict = Readonly<{
  readonly key: string;
  readonly name: string;
  readonly kinds: readonly BaselineConflictKind[];
  readonly choices: readonly BaselineResolution[];
  readonly otherUserOwned: boolean;
  readonly remoteUnreadable: boolean;
  readonly base: DecodedVariable | null;
  readonly local: DecodedVariable | null;
  readonly remote: DecodedVariable | null;
}>;

export type ReconciledVariable = DecodedVariable &
  Readonly<{ readonly hasDraftChange: boolean }>;

export type BaselineReconciliation = Readonly<{
  readonly merged: readonly ReconciledVariable[];
  readonly conflicts: readonly BaselineConflict[];
}>;

type Outcome = Readonly<{
  readonly present: boolean;
  readonly name: string;
  readonly description: string;
  readonly ownership: DecodedVariable["ownership"];
  readonly value: string | null;
  readonly required: boolean;
}>;

const absent = (): Outcome =>
  Object.freeze({
    present: false,
    name: "",
    description: "",
    ownership: "SHARED_VALUE",
    value: null,
    required: false,
  });

const outcomeOf = (variable: DecodedVariable | null | undefined): Outcome => {
  if (!variable || variable.tombstone) return absent();
  return Object.freeze({
    present: true,
    name: variable.name,
    description: variable.description,
    ownership: variable.ownership,
    value: variable.value,
    required: variable.required,
  });
};

const sameOutcome = (left: Outcome, right: Outcome): boolean =>
  left.present === right.present &&
  left.name === right.name &&
  left.description === right.description &&
  left.ownership === right.ownership &&
  left.value === right.value &&
  left.required === right.required;

const indexById = (
  variables: readonly DecodedVariable[],
): ReadonlyMap<string, DecodedVariable> => {
  const indexed = new Map<string, DecodedVariable>();
  for (const variable of variables) indexed.set(variable.id, variable);
  return indexed;
};

const liveByName = (
  variables: readonly DecodedVariable[],
): ReadonlyMap<string, DecodedVariable> => {
  const indexed = new Map<string, DecodedVariable>();
  for (const variable of variables) {
    if (!variable.tombstone) indexed.set(variable.name, variable);
  }
  return indexed;
};

const otherUserOwned = (
  variable: DecodedVariable | null,
  actorUserId: string | undefined,
): boolean =>
  variable !== null &&
  !variable.tombstone &&
  variable.ownership === "USER_DEFINED_VALUE" &&
  typeof variable.ownerUserId === "string" &&
  variable.ownerUserId.length > 0 &&
  variable.ownerUserId !== actorUserId;

const withChange = (
  variable: DecodedVariable,
  remote: DecodedVariable | null,
): ReconciledVariable =>
  Object.freeze({
    ...variable,
    hasDraftChange: !sameOutcome(outcomeOf(variable), outcomeOf(remote)),
  });

const kindsBetween = (
  local: DecodedVariable | null,
  remote: DecodedVariable | null,
  nameCollision: boolean,
): readonly BaselineConflictKind[] => {
  if (nameCollision) return Object.freeze(["name"]);
  const left = outcomeOf(local);
  const right = outcomeOf(remote);
  const kinds = new Set<BaselineConflictKind>();
  if (left.present !== right.present) kinds.add("deletion");
  if (left.present && right.present) {
    if (
      left.name !== right.name ||
      left.description !== right.description ||
      left.ownership !== right.ownership ||
      left.required !== right.required
    )
      kinds.add("definition");
    if (left.value !== right.value) kinds.add("value");
  }
  if (kinds.size === 0) kinds.add("value");
  return Object.freeze([...kinds].sort() as BaselineConflictKind[]);
};

const choicesFor = (
  kinds: readonly BaselineConflictKind[],
  ownedByOtherUser: boolean,
): readonly BaselineResolution[] => {
  if (ownedByOtherUser) return Object.freeze(["remote"]);
  if (kinds.length === 1 && (kinds[0] === "value" || kinds[0] === "name"))
    return Object.freeze(["local", "remote"]);
  return Object.freeze(["local", "remote", "merge"]);
};

const unreadableRemoteChange = (
  id: string,
  base: DecodedVariable | null,
  remote: DecodedVariable | null,
  changed: ReadonlySet<string>,
): boolean => {
  if (!changed.has(id) || !base || !remote) return false;
  if (base.tombstone || remote.tombstone) return false;
  return base.value === null || remote.value === null;
};

const remoteMoved = (
  id: string,
  base: DecodedVariable | null,
  remote: DecodedVariable | null,
  changed: ReadonlySet<string>,
): boolean =>
  !sameOutcome(outcomeOf(base), outcomeOf(remote)) ||
  unreadableRemoteChange(id, base, remote, changed);

/**
 * Three-way reconciliation of a Publication Baseline, a Draft, and the
 * Environment's current Manifest. Disjoint edits merge. Identical results
 * are not conflicts. A Variable changed on both sides is returned unresolved.
 */
export const reconcilePublicationBaseline = (
  input: Readonly<{
    readonly baseline: readonly DecodedVariable[];
    readonly draft: readonly DecodedVariable[];
    readonly remote: readonly DecodedVariable[];
    readonly remoteChangedVariableIds: ReadonlySet<string>;
    readonly actorUserId?: string;
  }>,
): BaselineReconciliation => {
  const baseline = indexById(input.baseline);
  const draft = indexById(input.draft);
  const remote = indexById(input.remote);
  const merged: ReconciledVariable[] = [];
  const conflicts: BaselineConflict[] = [];
  const consumedRemoteIds = new Set<string>();

  const consider = (
    id: string,
    base: DecodedVariable | null,
    local: DecodedVariable | null,
    current: DecodedVariable | null,
  ) => {
    const localChanged = !sameOutcome(outcomeOf(base), outcomeOf(local));
    const remoteChanged = remoteMoved(
      id,
      base,
      current,
      input.remoteChangedVariableIds,
    );
    if (!localChanged && !remoteChanged) {
      if (current) merged.push(withChange(current, current));
      return;
    }
    if (!localChanged) {
      if (current) merged.push(withChange(current, current));
      return;
    }
    if (!remoteChanged) {
      if (local) merged.push(withChange(local, current));
      else if (current && !current.tombstone)
        merged.push(
          withChange(
            Object.freeze({ ...current, value: null, tombstone: true }),
            current,
          ),
        );
      return;
    }
    if (sameOutcome(outcomeOf(local), outcomeOf(current))) {
      if (current) merged.push(withChange(current, current));
      else if (local) merged.push(withChange(local, current));
      return;
    }
    const ownedByOtherUser = otherUserOwned(current, input.actorUserId);
    const kinds = kindsBetween(local, current, false);
    conflicts.push(
      Object.freeze({
        key: id,
        name: local?.name || current?.name || base?.name || id,
        kinds,
        choices: choicesFor(kinds, ownedByOtherUser),
        otherUserOwned: ownedByOtherUser,
        remoteUnreadable:
          current !== null &&
          !current.tombstone &&
          current.value === null &&
          (ownedByOtherUser || input.remoteChangedVariableIds.has(id)),
        base,
        local,
        remote: current,
      }),
    );
  };

  for (const id of baseline.keys()) {
    consider(
      id,
      baseline.get(id) ?? null,
      draft.get(id) ?? null,
      remote.get(id) ?? null,
    );
    consumedRemoteIds.add(id);
  }

  const remoteLive = liveByName(input.remote);
  const localAdds = input.draft.filter(
    (variable) => !variable.tombstone && !baseline.has(variable.id),
  );
  for (const local of localAdds) {
    const current = remoteLive.get(local.name) ?? null;
    if (current && current.id !== local.id) {
      consumedRemoteIds.add(current.id);
      if (sameOutcome(outcomeOf(local), outcomeOf(current))) {
        merged.push(withChange(current, current));
        continue;
      }
      const ownedByOtherUser = otherUserOwned(current, input.actorUserId);
      const kinds = kindsBetween(local, current, true);
      conflicts.push(
        Object.freeze({
          key: `name:${local.name}`,
          name: local.name,
          kinds,
          choices: choicesFor(kinds, ownedByOtherUser),
          otherUserOwned: ownedByOtherUser,
          remoteUnreadable:
            current.value === null &&
            (ownedByOtherUser ||
              input.remoteChangedVariableIds.has(current.id)),
          base: null,
          local,
          remote: current,
        }),
      );
      continue;
    }
    merged.push(withChange(local, remote.get(local.id) ?? null));
  }

  for (const variable of input.remote) {
    if (consumedRemoteIds.has(variable.id) || baseline.has(variable.id))
      continue;
    if (localAdds.some((local) => local.name === variable.name)) continue;
    merged.push(withChange(variable, variable));
  }

  return Object.freeze({
    merged: Object.freeze(sortVariables(merged)),
    conflicts: Object.freeze(
      [...conflicts].sort((left, right) =>
        left.name === right.name
          ? left.key.localeCompare(right.key)
          : left.name.localeCompare(right.name),
      ),
    ),
  });
};

const sortVariables = (
  variables: readonly ReconciledVariable[],
): ReconciledVariable[] =>
  [...variables].sort((left, right) =>
    left.name === right.name
      ? left.id.localeCompare(right.id)
      : left.name.localeCompare(right.name),
  );

export const applyBaselineResolution = (
  conflict: BaselineConflict,
  choice: BaselineResolution,
): readonly ReconciledVariable[] => {
  if (!conflict.choices.includes(choice))
    throw new TypeError(`resolution ${choice} is not offered`);
  if (choice === "remote")
    return conflict.remote
      ? [withChange(conflict.remote, conflict.remote)]
      : [];
  if (choice === "merge") {
    const remote = conflict.remote;
    const local = conflict.local;
    if (!remote) return local ? [withChange(local, null)] : [];
    return [
      withChange(
        Object.freeze({
          ...remote,
          value: local?.value ?? null,
          tombstone: local ? local.tombstone : true,
        }),
        remote,
      ),
    ];
  }
  const results: ReconciledVariable[] = [];
  if (conflict.local) {
    const sameRemote =
      conflict.remote && conflict.remote.id === conflict.local.id
        ? conflict.remote
        : null;
    results.push(withChange(conflict.local, sameRemote));
  }
  if (
    conflict.remote &&
    !conflict.remote.tombstone &&
    (!conflict.local || conflict.remote.id !== conflict.local.id)
  ) {
    results.push(
      withChange(
        Object.freeze({ ...conflict.remote, value: null, tombstone: true }),
        conflict.remote,
      ),
    );
  }
  return results;
};

export const withResolvedConflicts = (
  reconciliation: BaselineReconciliation,
  choices: ReadonlyMap<string, BaselineResolution>,
): readonly ReconciledVariable[] => {
  const resolved: ReconciledVariable[] = [...reconciliation.merged];
  for (const conflict of reconciliation.conflicts) {
    const choice = choices.get(conflict.key);
    if (!choice) throw new TypeError(`conflict ${conflict.key} is unresolved`);
    resolved.push(...applyBaselineResolution(conflict, choice));
  }
  return Object.freeze(sortVariables(resolved));
};

export const changedVariableIdsSinceBaseline = (
  page: SyncPageWire,
  baselineRevisionId: string,
  emptyAnchor: boolean,
): ReadonlySet<string> => {
  const changed = new Set<string>();
  let include = emptyAnchor;
  for (const revision of page.revisions) {
    if (include) {
      for (const variableId of changedVariableIdsFromRevision(revision))
        changed.add(variableId);
    }
    if (revision.id === baselineRevisionId) include = true;
  }
  return changed;
};
