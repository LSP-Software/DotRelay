import { type InlineValueHunk, splitInlineValueDiff } from "@dotrelay/client";
import { glyph, heading, type KvRow, kv, paint, table } from "./components";
import type { DotenvDiffChange, ValueOwnership } from "./dotenv";
import { sanitizeCliText } from "./errors";
import type { Tone } from "./theme";

export type { ValueOwnership } from "./dotenv";

export type ValueDiff = Readonly<{
  readonly name: string;
  readonly from: string | null | undefined;
  readonly to: string | null | undefined;
  readonly ownership?: ValueOwnership | undefined;
}>;

export type PublicationChange = ValueDiff &
  Readonly<{
    readonly kind: "added" | "updated" | "removed";
  }>;

const MAX_VALUE_CHARS = 120;

const flattenDiffValue = (value: string): string =>
  sanitizeCliText(value).replace(/[\r\n\t]+/g, " ");

const truncateDiffValue = (value: string): string =>
  value.length <= MAX_VALUE_CHARS
    ? value
    : `${value.slice(0, MAX_VALUE_CHARS - 3)}...`;

const formatWholeValue = (value: string | null | undefined): string | null => {
  if (value === undefined) return null;
  if (value === null) return paint("not set", "faint");
  if (value === "") return paint("empty", "faint");
  return truncateDiffValue(flattenDiffValue(value));
};

const paintHunk = (hunk: InlineValueHunk, side: "from" | "to"): string => {
  const changed = side === "from" ? hunk.removed : hunk.added;
  const tone: Tone = side === "from" ? "danger" : "brand";
  return `${hunk.prefix ? paint(hunk.prefix, "faint") : ""}${
    changed ? paint(changed, tone) : ""
  }${hunk.suffix ? paint(hunk.suffix, "faint") : ""}`;
};

const markerLine = (
  indent: string,
  marker: "-" | "+",
  body: string,
  tone: Tone,
): string => `${indent}${paint(marker, tone)}  ${body}`;

export type RenderDiffOptions = Readonly<{
  readonly indent?: string;
  /** Plaintext Values are shown only when the operator passes --reveal. */
  readonly reveal?: boolean;
}>;

const ownershipSuffix = (ownership: ValueDiff["ownership"]): string =>
  ownership ? `  ${paint(ownership, "muted")}` : "";

const kindTone = (kind: PublicationChange["kind"]): Tone =>
  kind === "added" ? "brand" : kind === "removed" ? "danger" : "fg";

export const renderMaskedChange = (
  change: Pick<PublicationChange, "name" | "kind" | "ownership">,
  options: Readonly<{ readonly indent?: string }> = {},
): string =>
  `${options.indent ?? ""}${paint(sanitizeCliText(change.name), "fg")}${ownershipSuffix(
    change.ownership,
  )}  ${paint(change.kind, kindTone(change.kind))}`;

export const renderValueDiff = (
  diff: ValueDiff,
  options: RenderDiffOptions = {},
): readonly string[] => {
  const indent = options.indent ?? "";
  const rows = [
    `${indent}${paint(sanitizeCliText(diff.name), "fg")}${ownershipSuffix(
      diff.ownership,
    )}`,
  ];
  if (options.reveal !== true) return rows;
  if (typeof diff.from === "string" && typeof diff.to === "string") {
    const from = flattenDiffValue(diff.from);
    const to = flattenDiffValue(diff.to);
    if (from.length <= MAX_VALUE_CHARS && to.length <= MAX_VALUE_CHARS) {
      const hunk = splitInlineValueDiff(from, to);
      const showFrom = hunk.removed.length > 0;
      const showTo = hunk.added.length > 0 || !showFrom;
      if (showFrom)
        rows.push(markerLine(indent, "-", paintHunk(hunk, "from"), "danger"));
      if (showTo)
        rows.push(markerLine(indent, "+", paintHunk(hunk, "to"), "brand"));
      return rows;
    }
  }
  const from = formatWholeValue(diff.from);
  const to = formatWholeValue(diff.to);
  if (from !== null) rows.push(markerLine(indent, "-", from, "danger"));
  if (to !== null) rows.push(markerLine(indent, "+", to, "brand"));
  return rows;
};

export const valueDiffFromDotenvChange = (
  change: DotenvDiffChange,
): ValueDiff => {
  const base = { name: change.name, ownership: change.ownership };
  if (change.kind === "added")
    return { ...base, from: undefined, to: change.localValue };
  if (change.kind === "removed")
    return { ...base, from: change.remoteValue, to: undefined };
  return { ...base, from: change.remoteValue, to: change.localValue };
};

const joinDiffBlocks = (blocks: readonly (readonly string[])[]): string[] => {
  const lines: string[] = [];
  for (const [index, block] of blocks.entries()) {
    if (index > 0) lines.push("");
    lines.push(...block);
  }
  return lines;
};

export const diffSummary = (
  changes: readonly Pick<PublicationChange, "kind" | "ownership">[],
): string => {
  const added = changes.filter((change) => change.kind === "added").length;
  const updated = changes.filter((change) => change.kind === "updated").length;
  const removed = changes.filter((change) => change.kind === "removed").length;
  return [
    ...(added > 0 ? [`${added} added`] : []),
    ...(updated > 0 ? [`${updated} updated`] : []),
    ...(removed > 0 ? [`${removed} removed`] : []),
  ].join(", ");
};

const diffTable = (
  changes: readonly Pick<PublicationChange, "name" | "kind" | "ownership">[],
): string =>
  table(
    ["Variable", "Ownership", "Change"],
    changes.map((change) => [
      sanitizeCliText(change.name),
      change.ownership ?? null,
      change.kind,
    ]),
    changes.map((change) => ["fg", "muted", kindTone(change.kind)]),
  );

const revealedBlocks = (
  changes: readonly PublicationChange[],
  indent: string,
): string =>
  joinDiffBlocks(
    changes.map((change) => renderValueDiff(change, { indent, reveal: true })),
  ).join("\n");

export const renderEnvDiff = (
  changes: readonly DotenvDiffChange[],
  reveal: boolean = false,
): string => {
  const headingLine = heading("diff");
  if (changes.length === 0)
    return [
      headingLine,
      "",
      `  ${glyph("ok")}  ${paint("Your .env matches the Environment", "brand")}`,
      "",
    ].join("\n");
  const body = reveal
    ? changes
        .map((change) =>
          renderValueDiff(valueDiffFromDotenvChange(change), {
            reveal: true,
          }).join("\n"),
        )
        .join("\n\n")
    : diffTable(
        changes.map((change) => ({
          name: change.name,
          kind: change.kind,
          ownership: change.ownership,
        })),
      );
  return [headingLine, "", `${diffSummary(changes)}`, "", body, ""].join("\n");
};

export type PublicationDestination = Readonly<{
  readonly profile: string;
  readonly team: string;
  readonly project: string;
  readonly environment: string;
}>;

export const destinationRows = (
  destination: PublicationDestination,
): KvRow[] => [
  { key: "Profile", value: sanitizeCliText(destination.profile) },
  {
    key: "Environment",
    value: sanitizeCliText(destination.environment),
  },
];

export const reviewBody = (
  changes: readonly PublicationChange[] | null,
  destination: PublicationDestination,
  reveal: boolean,
  extra: readonly string[] = [],
): string => {
  const lines: string[] = [];
  if (changes !== null && changes.length > 0) {
    lines.push(diffSummary(changes));
    lines.push("");
    lines.push(reveal ? revealedBlocks(changes, "  ") : diffTable(changes));
    lines.push("");
  }
  lines.push(...extra);
  lines.push(kv(destinationRows(destination), 14));
  return lines.join("\n");
};

export const valueDiffsForPull = (
  changes: readonly DotenvDiffChange[],
): readonly PublicationChange[] =>
  Object.freeze(
    changes.map((change) => {
      if (change.kind === "added")
        return Object.freeze({
          kind: "removed" as const,
          name: change.name,
          from: change.localValue,
          to: undefined,
          ownership: change.ownership,
        });
      if (change.kind === "removed")
        return Object.freeze({
          kind: "added" as const,
          name: change.name,
          from: undefined,
          to: change.remoteValue,
          ownership: change.ownership,
        });
      return Object.freeze({
        kind: "updated" as const,
        name: change.name,
        from: change.localValue,
        to: change.remoteValue,
        ownership: change.ownership,
      });
    }),
  );

export const publicationConfirmQuestion = (): string => "Publish? [y/N]";

export const rollbackConfirmQuestion = (): string =>
  "Roll back the selected Variables? [y/N]";

export const pullConfirmQuestion = (path: string): string =>
  `Replace ${path} with decrypted values? [y/N]`;

export const ROLLBACK_NOTE =
  "This appends a new signed Rollback Revision; earlier Revisions are never rewritten or removed.";
