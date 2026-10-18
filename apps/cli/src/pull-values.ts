import type { DecodedVariable } from "@dotrelay/client";

export type PullValueGroups = Readonly<{
  readonly present: readonly DecodedVariable[];
  readonly optionalAbsent: readonly DecodedVariable[];
  readonly requiredMissing: readonly DecodedVariable[];
  readonly unreadable: readonly DecodedVariable[];
}>;

const byName = (
  variables: readonly DecodedVariable[],
): readonly DecodedVariable[] =>
  [...variables].sort((left, right) => left.name.localeCompare(right.name));

export const classifyPullValues = (
  variables: readonly DecodedVariable[],
  actorUserId: string | undefined,
): PullValueGroups => {
  const present: DecodedVariable[] = [];
  const optionalAbsent: DecodedVariable[] = [];
  const requiredMissing: DecodedVariable[] = [];
  const unreadable: DecodedVariable[] = [];
  for (const variable of variables) {
    if (variable.tombstone) continue;
    if (variable.value !== null) {
      present.push(variable);
      continue;
    }
    const ownedByOtherUser =
      variable.ownership === "USER_DEFINED_VALUE" &&
      typeof variable.ownerUserId === "string" &&
      variable.ownerUserId.length > 0 &&
      variable.ownerUserId !== actorUserId;
    if (ownedByOtherUser) unreadable.push(variable);
    else if (variable.required) requiredMissing.push(variable);
    else optionalAbsent.push(variable);
  }
  return Object.freeze({
    present: Object.freeze(byName(present)),
    optionalAbsent: Object.freeze(byName(optionalAbsent)),
    requiredMissing: Object.freeze(byName(requiredMissing)),
    unreadable: Object.freeze(byName(unreadable)),
  });
};

export const pullVariableNames = (
  variables: readonly DecodedVariable[],
): string => variables.map((variable) => variable.name).join(", ");
