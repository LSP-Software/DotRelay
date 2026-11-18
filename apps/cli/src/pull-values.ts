import type { DecodedVariable } from "@dotrelay/client";
import { sanitizeCliLine } from "./errors";

export type PullValueGroups = Readonly<{
  readonly present: readonly DecodedVariable[];
  readonly optionalAbsent: readonly DecodedVariable[];
  readonly requiredMissing: readonly DecodedVariable[];
  readonly unreadable: readonly DecodedVariable[];
  /**
   * "Only me" Values another member set. They are private to that member
   * and the service never sends them here, so they are left out of the
   * file rather than treated as missing or broken (ADR 0008).
   */
  readonly othersPrivate: readonly DecodedVariable[];
}>;

export const classifyPullValues = (
  variables: readonly DecodedVariable[],
  actorUserId: string | undefined,
): PullValueGroups => {
  const present: DecodedVariable[] = [];
  const optionalAbsent: DecodedVariable[] = [];
  const requiredMissing: DecodedVariable[] = [];
  const unreadable: DecodedVariable[] = [];
  const othersPrivate: DecodedVariable[] = [];
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
    if (ownedByOtherUser) othersPrivate.push(variable);
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
    othersPrivate: Object.freeze(othersPrivate),
  });
};

/**
 * A one-line note naming the teammates' private values a command left out,
 * or "" when there are none.
 */
export const othersPrivateNote = (
  variables: readonly DecodedVariable[],
): string =>
  variables.length === 0
    ? ""
    : `${pullVariableNames(variables)} ${variables.length === 1 ? "is" : "are"} private to another member ("Only me"), so ${variables.length === 1 ? "it was" : "they were"} left out.`;

export const pullVariableNames = (
  variables: readonly DecodedVariable[],
): string =>
  variables.map((variable) => sanitizeCliLine(variable.name)).join(", ");
