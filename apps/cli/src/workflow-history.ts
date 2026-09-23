import {
  changedVariableIdsFromRevision,
  type DecodedVariable,
  type SyncPageWire,
} from "@dotrelay/client";
import type { SyncRevisionWire } from "@dotrelay/contracts";
import { heading } from "./components";
import { sanitizeCliText } from "./errors";
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

const mutationLabel = (mutation: number): string =>
  mutation === 1
    ? "Genesis"
    : mutation === 2
      ? "Update"
      : mutation === 3
        ? "Rollback"
        : mutation === 4
          ? "Epoch transition"
          : mutation === 5
            ? "User-key rotation"
            : `Mutation ${mutation}`;

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
const renderRevisionHistory = (
  environmentId: string,
  rows: readonly RevisionHistoryRow[],
): string => {
  const headingLine = heading("history");
  if (rows.length === 0)
    return [
      headingLine,
      `  ${paint("Environment", "faint")} ${paint(
        sanitizeCliText(environmentId),
        "muted",
      )}`,
      `  ${paint("No Revisions have been published yet.", "muted")}`,
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
        : ` of ${row.revision.rollbackTargetId}`;
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
      label = parts.length > 0 ? `${parts.join(", ")} — ${label}` : label;
    }
    return label;
  };
  const lines: string[] = [
    headingLine,
    "",
    `  ${paint("Environment", "faint")} ${paint(
      sanitizeCliText(environmentId),
      "muted",
    )}`,
    "",
  ];
  for (const row of rows) {
    const marker = row.current ? paint("  current", "brand") : "         ";
    lines.push(
      `  ${paint(`#${row.ordinal}`, "muted")}  ${paint(
        revisionDate(row.revision.authoredAtMs),
        "fg",
      )}  ${paint(row.revision.id, "faint")}  ${paint(
        summaryFor(row),
        mutationTone(row.revision.mutation),
      )}${marker}`,
    );
    for (const change of row.changes) {
      const ownership = paint(change.ownership, "muted");
      if (change.kind === "added")
        lines.push(
          `     ${paint("+", "brand")}  ${paint(change.name, "fg")}  ${ownership}`,
        );
      else if (change.kind === "removed")
        lines.push(
          `     ${paint("-", "danger")}  ${paint(change.name, "fg")}  ${ownership}`,
        );
      else
        lines.push(
          `     ${paint("~", "warn")}  ${paint(change.name, "fg")}${
            change.valueChanged ? `  ${paint("value changed", "faint")}` : ""
          }`,
        );
    }
  }
  lines.push("");
  return lines.join("\n");
};

export const renderSyncedHistory = (
  synced: Awaited<ReturnType<typeof syncWorkflow>>,
): string =>
  renderRevisionHistory(
    synced.page.environmentId,
    revisionHistoryRows(
      synced.page,
      synced.workflow.session.revisionSnapshots(),
    ),
  );
