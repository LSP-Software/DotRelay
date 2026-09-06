import {
  bytesToUuid,
  parseProtocolObject,
  type SyncRevisionWire,
} from "@dotrelay/client";
import type { EnvironmentVariable } from "./environment-workflow";

export type HistoryKind = "genesis" | "update" | "rollback";

export type ManifestSnapshotVariable = Pick<
  EnvironmentVariable,
  "id" | "name" | "description" | "value" | "tombstone"
>;

export type ManifestChangeSummary = Readonly<{
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly addedNames: readonly string[];
  readonly changedNames: readonly string[];
  readonly removedNames: readonly string[];
}>;

export type EnvironmentHistoryEntry = Readonly<{
  readonly revisionId: string;
  readonly authoredAtMs: number;
  readonly authorUserId: string | null;
  readonly authorLabel: string;
  readonly kind: HistoryKind;
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly addedNames: readonly string[];
  readonly changedNames: readonly string[];
  readonly removedNames: readonly string[];
}>;

export type HistoryDayGroup = Readonly<{
  readonly label: string;
  readonly entries: readonly EnvironmentHistoryEntry[];
}>;

export const HISTORY_PAGE_SIZE = 25;

export const nextHistoryVisibleCount = (
  visibleCount: number,
  total: number,
): number => Math.min(total, visibleCount + HISTORY_PAGE_SIZE);

const NAMED_LIMIT = 3;
const UNKNOWN_AUTHOR = "A Member";

const isLive = (variable: ManifestSnapshotVariable): boolean =>
  variable.tombstone !== true;

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const historyKind = (mutation: number): HistoryKind => {
  if (mutation === 1) return "genesis";
  if (mutation === 3) return "rollback";
  return "update";
};

export const summarizeManifestChange = (
  previous: readonly ManifestSnapshotVariable[],
  next: readonly ManifestSnapshotVariable[],
): ManifestChangeSummary => {
  const previousById = new Map(
    previous.map((variable) => [variable.id, variable]),
  );
  const nextById = new Map(next.map((variable) => [variable.id, variable]));
  const addedNames: string[] = [];
  const changedNames: string[] = [];
  const removedNames: string[] = [];

  for (const variable of next) {
    const prior = previousById.get(variable.id);
    if (!isLive(variable)) {
      if (prior && isLive(prior)) removedNames.push(prior.name);
      continue;
    }
    if (!prior || !isLive(prior)) {
      addedNames.push(variable.name);
      continue;
    }
    if (
      prior.value !== variable.value ||
      prior.name !== variable.name ||
      prior.description !== variable.description
    )
      changedNames.push(variable.name);
  }

  for (const variable of previous) {
    if (!isLive(variable) || nextById.has(variable.id)) continue;
    removedNames.push(variable.name);
  }

  return Object.freeze({
    added: addedNames.length,
    changed: changedNames.length,
    removed: removedNames.length,
    addedNames: Object.freeze(addedNames),
    changedNames: Object.freeze(changedNames),
    removedNames: Object.freeze(removedNames),
  });
};

const dayKey = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const calendarLabel = (ms: number, now = Date.now()): string => {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

export const formatRelativeTime = (
  authoredAtMs: number,
  now = Date.now(),
): string => {
  const deltaMs = now - authoredAtMs;
  if (deltaMs < 45_000) return "just now";
  if (deltaMs < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.round(deltaMs / 60_000));
    return `${minutes}m ago`;
  }
  if (deltaMs < 24 * 60 * 60 * 1000) {
    const hours = Math.max(1, Math.round(deltaMs / (60 * 60 * 1000)));
    return `${hours}h ago`;
  }
  const authoredDay = dayKey(authoredAtMs);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (authoredDay === dayKey(yesterday.getTime())) return "yesterday";
  if (deltaMs < 7 * 24 * 60 * 60 * 1000) {
    return new Date(authoredAtMs).toLocaleDateString("en-GB", {
      weekday: "short",
    });
  }
  return calendarLabel(authoredAtMs, now);
};

export const formatDayLabel = (
  authoredAtMs: number,
  now = Date.now(),
): string => {
  const authoredDay = dayKey(authoredAtMs);
  if (authoredDay === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (authoredDay === dayKey(yesterday.getTime())) return "Yesterday";
  return calendarLabel(authoredAtMs, now);
};

export const groupHistoryByDay = (
  entries: readonly EnvironmentHistoryEntry[],
  now = Date.now(),
): readonly HistoryDayGroup[] => {
  const groups: HistoryDayGroup[] = [];
  for (const entry of entries) {
    const label = formatDayLabel(entry.authoredAtMs, now);
    const current = groups[groups.length - 1];
    if (current && current.label === label) {
      groups[groups.length - 1] = {
        label,
        entries: [...current.entries, entry],
      };
      continue;
    }
    groups.push({ label, entries: [entry] });
  }
  return Object.freeze(
    groups.map((group) =>
      Object.freeze({
        label: group.label,
        entries: Object.freeze([...group.entries]),
      }),
    ),
  );
};

const joinNames = (names: readonly string[]): string => {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const last = names[names.length - 1] ?? "";
  return `${names.slice(0, -1).join(", ")}, and ${last}`;
};

const variablePhrase = (count: number): string =>
  count === 1 ? "1 variable" : `${count} variables`;

const namedClause = (
  verb: string,
  names: readonly string[],
): string | null => (names.length === 0 ? null : `${verb} ${joinNames(names)}`);

const joinClauses = (clauses: readonly string[]): string =>
  clauses
    .map((clause, index) => {
      if (index === 0) return clause;
      const first = clause[0];
      if (!first) return clause;
      return `${first.toLowerCase()}${clause.slice(1)}`;
    })
    .join(", ");

export const formatPublishSummary = (
  entry: Pick<
    EnvironmentHistoryEntry,
    | "kind"
    | "added"
    | "changed"
    | "removed"
    | "addedNames"
    | "changedNames"
    | "removedNames"
  >,
): string => {
  const namedCount =
    entry.addedNames.length +
    entry.changedNames.length +
    entry.removedNames.length;
  if (entry.kind === "genesis") {
    if (entry.addedNames.length > 0 && namedCount <= NAMED_LIMIT)
      return `Started with ${joinNames(entry.addedNames)}`;
    if (entry.added > 0) return `Started with ${variablePhrase(entry.added)}`;
    return "Started this Environment";
  }

  const namedClauses = [
    namedClause("Added", entry.addedNames),
    namedClause("Changed", entry.changedNames),
    namedClause("Removed", entry.removedNames),
  ].filter((clause): clause is string => clause !== null);
  if (namedCount > 0 && namedCount <= NAMED_LIMIT)
    return joinClauses(namedClauses);

  const kinds = [
    entry.added > 0 ? ("added" as const) : null,
    entry.changed > 0 ? ("changed" as const) : null,
    entry.removed > 0 ? ("removed" as const) : null,
  ].filter((kind): kind is "added" | "changed" | "removed" => kind !== null);
  if (kinds.length === 1) {
    const kind = kinds[0];
    if (!kind) return "No variable changes";
    const count =
      kind === "added"
        ? entry.added
        : kind === "changed"
          ? entry.changed
          : entry.removed;
    return `${variablePhrase(count)} ${kind}`;
  }
  if (kinds.length > 1) {
    const parts: string[] = [];
    if (entry.added > 0) parts.push(`${entry.added} added`);
    if (entry.changed > 0) parts.push(`${entry.changed} changed`);
    if (entry.removed > 0) parts.push(`${entry.removed} removed`);
    return parts.join(", ");
  }
  return entry.kind === "rollback" ? "Rolled back" : "No variable changes";
};

export const authorInitials = (label: string): string => {
  const parts = label
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const firstWord = parts[0];
  if (!firstWord) return "?";
  if (parts.length === 1) return firstWord.slice(0, 2).toUpperCase();
  const lastWord = parts[parts.length - 1] ?? firstWord;
  const first = firstWord[0];
  const last = lastWord[0];
  if (!first || !last) return "?";
  return `${first}${last}`.toUpperCase();
};

export const revisionActorUserId = (
  revision: SyncRevisionWire,
): string | null => {
  const revisionObject = revision.objects.find((object) =>
    bytesEqual(object.digest, revision.digest),
  );
  if (!revisionObject) return null;
  try {
    const actor = parseProtocolObject(revisionObject.canonicalBytes).get(22);
    if (actor instanceof Uint8Array && actor.length === 16)
      return bytesToUuid(actor);
  } catch {
    return null;
  }
  return null;
};

const changedCountFromRevision = (revision: SyncRevisionWire): number => {
  const revisionObject = revision.objects.find((object) =>
    bytesEqual(object.digest, revision.digest),
  );
  if (!revisionObject) return 0;
  try {
    const changed = parseProtocolObject(revisionObject.canonicalBytes).get(54);
    if (!Array.isArray(changed)) return 0;
    return changed.length;
  } catch {
    return 0;
  }
};

const resolveAuthorLabel = (input: {
  readonly actorUserId: string | null;
  readonly actorLabels?: Readonly<Record<string, string>>;
  readonly currentUserId?: string;
  readonly currentUserLabel?: string;
}): string => {
  if (input.actorUserId) {
    const mapped = input.actorLabels?.[input.actorUserId];
    if (mapped) return mapped;
  }
  if (
    input.actorUserId &&
    input.currentUserId &&
    input.actorUserId === input.currentUserId &&
    input.currentUserLabel
  )
    return input.currentUserLabel;
  return UNKNOWN_AUTHOR;
};

export const historyEntriesFromSync = (input: {
  readonly revisions: readonly SyncRevisionWire[];
  readonly snapshots: ReadonlyMap<string, readonly ManifestSnapshotVariable[]>;
  readonly actorLabels?: Readonly<Record<string, string>>;
  readonly currentUserId?: string;
  readonly currentUserLabel?: string;
}): readonly EnvironmentHistoryEntry[] => {
  const entries: EnvironmentHistoryEntry[] = [];
  let previous: readonly ManifestSnapshotVariable[] = [];
  for (const revision of input.revisions) {
    const snapshot = input.snapshots.get(revision.id);
    const change = snapshot
      ? summarizeManifestChange(previous, snapshot)
      : Object.freeze({
          added: 0,
          changed: changedCountFromRevision(revision),
          removed: 0,
          addedNames: Object.freeze([] as string[]),
          changedNames: Object.freeze([] as string[]),
          removedNames: Object.freeze([] as string[]),
        });
    const actorUserId = revisionActorUserId(revision);
    entries.push(
      Object.freeze({
        revisionId: revision.id,
        authoredAtMs: Number(revision.authoredAtMs),
        authorUserId: actorUserId,
        authorLabel: resolveAuthorLabel({
          actorUserId,
          ...(input.actorLabels ? { actorLabels: input.actorLabels } : {}),
          ...(input.currentUserId
            ? { currentUserId: input.currentUserId }
            : {}),
          ...(input.currentUserLabel
            ? { currentUserLabel: input.currentUserLabel }
            : {}),
        }),
        kind: historyKind(revision.mutation),
        ...change,
      }),
    );
    if (snapshot) previous = snapshot;
  }
  return Object.freeze(entries.reverse());
};

export const previewHistoryEntries = (
  authorLabel: string,
  now = Date.now(),
): readonly EnvironmentHistoryEntry[] =>
  Object.freeze([
    Object.freeze({
      revisionId: "rev_0184",
      authoredAtMs: now - 8 * 60 * 1000,
      authorUserId: null,
      authorLabel,
      kind: "update" as const,
      added: 0,
      changed: 1,
      removed: 0,
      addedNames: Object.freeze([] as string[]),
      changedNames: Object.freeze(["API_ORIGIN"]),
      removedNames: Object.freeze([] as string[]),
    }),
    Object.freeze({
      revisionId: "rev_0183",
      authoredAtMs: now - 26 * 60 * 60 * 1000,
      authorUserId: null,
      authorLabel,
      kind: "update" as const,
      added: 1,
      changed: 1,
      removed: 0,
      addedNames: Object.freeze(["FEATURE_GATE"]),
      changedNames: Object.freeze(["API_ORIGIN"]),
      removedNames: Object.freeze([] as string[]),
    }),
    Object.freeze({
      revisionId: "rev_0182",
      authoredAtMs: now - 6 * 24 * 60 * 60 * 1000,
      authorUserId: null,
      authorLabel: "Maya Okonkwo",
      kind: "genesis" as const,
      added: 2,
      changed: 0,
      removed: 0,
      addedNames: Object.freeze(["API_ORIGIN", "SIGNING_KEY"]),
      changedNames: Object.freeze([] as string[]),
      removedNames: Object.freeze([] as string[]),
    }),
  ]);
