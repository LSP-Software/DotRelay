import {
  changedVariableIdsFromRevision,
  type DecodedVariable,
  type SyncPageWire,
} from "@dotrelay/client";
import {
  bytesToUuid,
  parseProtocolObject,
  type SyncRevisionWire,
} from "@dotrelay/contracts";
import { bar, GLYPHS, heading } from "./components";
import { sanitizeCliLine, sanitizeCliText } from "./errors";
import type { Tone } from "./theme";
import { paint } from "./ui";
import { classificationFromOwnership } from "./workflow-publication";
import type { syncWorkflow } from "./workflow-session";

export type RevisionHistoryChange = Readonly<{
  readonly kind: "added" | "removed" | "changed";
  readonly name: string;
  readonly ownership: "shared" | "user-defined";
  readonly valueChanged: boolean;
}>;

export type RevisionHistoryRow = Readonly<{
  readonly ordinal: number;
  readonly revision: SyncRevisionWire;
  readonly current: boolean;
  readonly changes: readonly RevisionHistoryChange[];
}>;

// The revision object records which Variables the Revision touched (the
// client's changedVariableIdsFromRevision verifies those lane identities);
// the session's decoded snapshots show what each Variable looked like
// before and after. Together they are the change context this Device may
// render; Values themselves never enter history output.
export const revisionHistoryRows = (
  page: SyncPageWire,
  snapshots: ReadonlyMap<string, readonly DecodedVariable[]>,
): readonly RevisionHistoryRow[] => {
  let previous: readonly DecodedVariable[] = [];
  const rows: RevisionHistoryRow[] = [];
  page.revisions.forEach((revision, index) => {
    const current = snapshots.get(revision.id) ?? [];
    const previousById = new Map(
      previous.map((variable) => [variable.id, variable]),
    );
    const currentById = new Map(
      current.map((variable) => [variable.id, variable]),
    );
    const changes: RevisionHistoryChange[] = [];
    for (const id of changedVariableIdsFromRevision(revision)) {
      const before = previousById.get(id);
      const after = currentById.get(id);
      if (!after) continue;
      const ownership = classificationFromOwnership(after.ownership);
      if (after.tombstone) {
        if (before && !before.tombstone)
          changes.push(
            Object.freeze({
              kind: "removed" as const,
              name: after.name,
              ownership,
              valueChanged: false,
            }),
          );
        continue;
      }
      if (!before || before.tombstone) {
        changes.push(
          Object.freeze({
            kind: "added" as const,
            name: after.name,
            ownership,
            valueChanged: false,
          }),
        );
        continue;
      }
      const valueChanged =
        before.value !== null &&
        after.value !== null &&
        before.value !== after.value;
      const definitionChanged =
        before.name !== after.name ||
        before.description !== after.description ||
        before.ownership !== after.ownership ||
        before.required !== after.required;
      if (valueChanged || definitionChanged)
        changes.push(
          Object.freeze({
            kind: "changed" as const,
            name: after.name,
            ownership,
            valueChanged,
          }),
        );
    }
    rows.push(
      Object.freeze({
        ordinal: index + 1,
        revision,
        current: page.currentHeadId === revision.id,
        changes: Object.freeze(changes),
      }),
    );
    previous = current;
  });
  return Object.freeze(rows);
};

// The author lives in the signed Revision object, not the wire record. Only
// read it from a page the session verified: the signature covers it there,
// so it is what the signer wrote.
export const revisionAuthorUserId = (
  revision: SyncRevisionWire,
): string | null => {
  try {
    const object = revision.objects.find(
      (candidate) =>
        candidate.digest.length === revision.digest.length &&
        candidate.digest.every(
          (byte, index) => byte === revision.digest[index],
        ),
    );
    if (!object) return null;
    const author = parseProtocolObject(object.canonicalBytes).get(22);
    return author instanceof Uint8Array && author.length === 16
      ? bytesToUuid(author)
      : null;
  } catch {
    return null;
  }
};

/** Who published each Revision, as this Device can name them. */
export type HistoryAuthors = Readonly<{
  readonly actorUserId?: string | undefined;
  readonly names: ReadonlyMap<string, string>;
}>;

const authorLabel = (
  revision: SyncRevisionWire,
  authors: HistoryAuthors | undefined,
): string | null => {
  if (!authors) return null;
  const userId = revisionAuthorUserId(revision);
  if (userId === null) return null;
  if (userId === authors.actorUserId) return "by you";
  const name = authors.names.get(userId);
  return name ? `by ${sanitizeCliLine(name)}` : "by a former member";
};

const mutationLabel = (mutation: number): string =>
  mutation === 1
    ? "Created"
    : mutation === 2
      ? "Update"
      : mutation === 3
        ? "Rollback"
        : mutation === 4
          ? "Project key rotation"
          : mutation === 5
            ? "Key rotation (Only me values)"
            : `Unknown change (${mutation})`;

const mutationTone = (mutation: number): Tone =>
  mutation === 3 ? "warn" : mutation === 1 ? "accent" : "fg";

const revisionDate = (authoredAtMs: bigint): string => {
  const date = new Date(Number(authoredAtMs));
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
};

// Human history: enough readable context to tell the Revisions apart and to
// pick a Rollback target without decrypting anything, while `--json` keeps
// the documented revision metadata for automation.
export const renderRevisionHistory = (
  environment: string,
  rows: readonly RevisionHistoryRow[],
  authors?: HistoryAuthors,
): string => {
  // History reads like every other command: each line on the rail, and a
  // closing mark.
  const headingLine = heading("history");
  const end = paint(GLYPHS.end, "ghost");
  const environmentLine = `${bar()}  ${paint("Environment", "faint")} ${paint(
    sanitizeCliText(environment),
    "muted",
  )}`;
  if (rows.length === 0)
    return [
      headingLine,
      bar(),
      environmentLine,
      `${bar()}  ${paint("Nothing has been published to this environment yet.", "muted")}`,
      end,
      "",
    ].join("\n");
  const ordinalById = new Map(
    rows.map((row) => [row.revision.id, row.ordinal]),
  );
  const summaryFor = (row: RevisionHistoryRow): string => {
    let label = mutationLabel(row.revision.mutation);
    if (row.revision.rollbackTargetId) {
      const targetOrdinal = ordinalById.get(row.revision.rollbackTargetId);
      label += targetOrdinal
        ? ` of #${targetOrdinal}`
        : ` of ${sanitizeCliLine(row.revision.rollbackTargetId)}`;
    }
    const changes = row.changes;
    if (changes.length > 0) {
      const counts = new Map<string, number>();
      for (const change of changes)
        counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
      const parts = [
        counts.get("added") ? `${counts.get("added")} added` : "",
        counts.get("changed") ? `${counts.get("changed")} changed` : "",
        counts.get("removed") ? `${counts.get("removed")} removed` : "",
      ].filter((part) => part.length > 0);
      label = parts.length > 0 ? `${label}: ${parts.join(", ")}` : label;
    }
    return label;
  };
  const lines: string[] = [headingLine, bar(), environmentLine, bar()];
  for (const row of rows) {
    const marker = row.current ? paint("  current", "brand") : "         ";
    const author = authorLabel(row.revision, authors);
    lines.push(
      `${bar()}  ${paint(`#${row.ordinal}`, "muted")}  ${paint(
        revisionDate(row.revision.authoredAtMs),
        "fg",
      )}  ${paint(sanitizeCliLine(row.revision.id), "faint")}  ${paint(
        summaryFor(row),
        mutationTone(row.revision.mutation),
      )}${author ? `  ${paint(author, "muted")}` : ""}${marker}`,
    );
    for (const change of row.changes) {
      const ownership = paint(
        change.ownership === "shared" ? "Team" : "Only me",
        "muted",
      );
      if (change.kind === "added")
        lines.push(
          `${bar()}     ${paint("+", "brand")}  ${paint(sanitizeCliLine(change.name), "fg")}  ${ownership}`,
        );
      else if (change.kind === "removed")
        lines.push(
          `${bar()}     ${paint("-", "danger")}  ${paint(sanitizeCliLine(change.name), "fg")}  ${ownership}`,
        );
      else
        lines.push(
          `${bar()}     ${paint("~", "warn")}  ${paint(sanitizeCliLine(change.name), "fg")}${
            change.valueChanged ? `  ${paint("value changed", "faint")}` : ""
          }`,
        );
    }
  }
  lines.push(end, "");
  return lines.join("\n");
};

export const renderSyncedHistory = (
  synced: Awaited<ReturnType<typeof syncWorkflow>>,
  environmentLabel?: string,
  authors?: HistoryAuthors,
): string =>
  renderRevisionHistory(
    environmentLabel ?? synced.page.environmentId,
    revisionHistoryRows(
      synced.page,
      synced.workflow.session.revisionSnapshots(),
    ),
    authors,
  );
