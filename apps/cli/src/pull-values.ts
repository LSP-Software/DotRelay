import type { DecodedVariable } from "@dotrelay/client";

export type PullValueGroups = Readonly<{
  readonly present: readonly DecodedVariable[];
  readonly optionalAbsent: readonly DecodedVariable[];
  readonly requiredMissing: readonly DecodedVariable[];
  readonly unreadable: readonly DecodedVariable[];
}>;

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
  // Keep the Environment's order. Pull writes these groups straight into
  // the dotenv file, and sorting them by name changes that file.
  return Object.freeze({
    present: Object.freeze(present),
    optionalAbsent: Object.freeze(optionalAbsent),
    requiredMissing: Object.freeze(requiredMissing),
    unreadable: Object.freeze(unreadable),
  });
};

export const pullVariableNames = (
  variables: readonly DecodedVariable[],
): string => variables.map((variable) => variable.name).join(", ");
