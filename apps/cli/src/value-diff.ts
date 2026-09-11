import { type InlineValueHunk, splitInlineValueDiff } from "@dotrelay/client";
import type { DotenvDiffChange, ValueOwnership } from "./dotenv";
import { sanitizeCliText } from "./errors";
import { type ColorRole, paint } from "./ui";

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
  if (value === null) return "not set";
  if (value === "") return "empty";
  return truncateDiffValue(flattenDiffValue(value));
};

const paintHunk = (hunk: InlineValueHunk, side: "from" | "to"): string => {
  const changed = side === "from" ? hunk.removed : hunk.added;
  const tone: ColorRole = side === "from" ? "wax" : "ok";
  return `${hunk.prefix ? paint(hunk.prefix, "dim") : ""}${
    changed ? paint(changed, tone) : ""
  }${hunk.suffix ? paint(hunk.suffix, "dim") : ""}`;
};

const markerLine = (
  indent: string,
  marker: "-" | "+",
  body: string,
  tone: ColorRole,
): string => `${indent}${paint(marker, tone)}  ${body}`;

export type RenderDiffOptions = Readonly<{
  readonly indent?: string;
  /** Plaintext Values are shown only when the operator passes --reveal. */
  readonly reveal?: boolean;
}>;

const ownershipSuffix = (ownership: ValueDiff["ownership"]): string =>
  ownership ? `  ${paint(ownership, "dim")}` : "";

const kindTone = (kind: PublicationChange["kind"]): ColorRole =>
  kind === "added" ? "ok" : kind === "removed" ? "wax" : "paper";

export const renderMaskedChange = (
  change: Pick<PublicationChange, "name" | "kind" | "ownership">,
  options: Readonly<{ readonly indent?: string }> = {},
): string =>
  `${options.indent ?? "     "}${paint(sanitizeCliText(change.name), "paper")}${ownershipSuffix(
    change.ownership,
  )}  ${paint(change.kind, kindTone(change.kind))}`;

export const renderValueDiff = (
  diff: ValueDiff,
  options: RenderDiffOptions = {},
): readonly string[] => {
  const indent = options.indent ?? "     ";
  const rows = [
    `${indent}${paint(sanitizeCliText(diff.name), "paper")}${ownershipSuffix(
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
        rows.push(markerLine(indent, "-", paintHunk(hunk, "from"), "wax"));
      if (showTo)
        rows.push(markerLine(indent, "+", paintHunk(hunk, "to"), "ok"));
      return rows;
    }
  }
  const from = formatWholeValue(diff.from);
  const to = formatWholeValue(diff.to);
  if (from !== null)
    rows.push(markerLine(indent, "-", paint(from, "wax"), "wax"));
  if (to !== null) rows.push(markerLine(indent, "+", paint(to, "ok"), "ok"));
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

const shortSummary = (
  changes: readonly Pick<PublicationChange, "kind">[],
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

export const renderEnvDiff = (
  changes: readonly DotenvDiffChange[],
  reveal: boolean = false,
): string => {
  if (changes.length === 0)
    return [
      `  ${paint("·", "wax")}  ${paint("Local .env matches the Environment", "paper")}`,
      "",
    ].join("\n");
  const body = reveal
    ? joinDiffBlocks(
        changes.map((change) =>
          renderValueDiff(valueDiffFromDotenvChange(change), {
            reveal: true,
          }),
        ),
      )
    : changes.map((change) =>
        renderMaskedChange({
          name: change.name,
          kind: change.kind,
          ownership: change.ownership,
        }),
      );
  return [
    `  ${paint("·", "wax")}  ${paint(shortSummary(changes), "paper")}`,
    "",
    ...body,
    "",
  ].join("\n");
};

export type PublicationDestination = Readonly<{
  readonly profile: string;
  readonly team: string;
  readonly project: string;
  readonly environment: string;
}>;

export const renderDestinationLines = (
  destination: PublicationDestination,
): string[] => [
  `Profile: ${sanitizeCliText(destination.profile)}`,
  `Team: ${sanitizeCliText(destination.team)}`,
  `Project: ${sanitizeCliText(destination.project)}`,
  `Environment: ${sanitizeCliText(destination.environment)}`,
];

const countLabel = (count: number, action: string): string =>
  `${count} ${count === 1 ? "variable" : "variables"} being ${action}`;

const confirmQuestionWithDiff = (
  changes: readonly PublicationChange[] | null,
  destination: PublicationDestination,
  prompt: string,
  reveal: boolean = false,
): string => {
  const lines: string[] = [];
  if (changes !== null && changes.length > 0) {
    const added = changes.filter((change) => change.kind === "added").length;
    const updated = changes.filter(
      (change) => change.kind === "updated",
    ).length;
    const removed = changes.filter(
      (change) => change.kind === "removed",
    ).length;
    const summary = [
      ...(added > 0 ? [countLabel(added, "added")] : []),
      ...(updated > 0 ? [countLabel(updated, "updated")] : []),
      ...(removed > 0 ? [countLabel(removed, "removed")] : []),
    ].join(", ");
    if (summary.length > 0) lines.push(summary);
    const body = reveal
      ? joinDiffBlocks(
          changes.map((change) =>
            renderValueDiff(change, { indent: "  ", reveal: true }),
          ),
        ).join("\n")
      : changes
          .map((change) => renderMaskedChange(change, { indent: "  " }))
          .join("\n");
    if (body.length > 0) lines.push(body);
  }
  if (lines.length > 0) lines.push("");
  lines.push(...renderDestinationLines(destination));
  lines.push(prompt);
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

export const publicationConfirmQuestion = (
  changes: readonly PublicationChange[],
  destination: PublicationDestination,
  reveal: boolean = false,
): string => confirmQuestionWithDiff(changes, destination, "Publish?", reveal);

export const pullConfirmQuestion = (
  path: string,
  changes: readonly PublicationChange[] | null,
  destination: PublicationDestination,
  reveal: boolean = false,
): string =>
  confirmQuestionWithDiff(
    changes,
    destination,
    `Replace ${path} with decrypted Values?`,
    reveal,
  );
