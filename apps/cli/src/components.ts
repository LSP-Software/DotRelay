import {
  bold,
  dim,
  pad,
  paint,
  type Tone,
  terminalWidth,
  truncate,
  visibleWidth,
} from "./theme";

export type { Tone };
export { bold, dim, paint, terminalWidth, truncate, visibleWidth };

export const GLYPHS = Object.freeze({
  dot: "●",
  cursor: "▸",
  item: "·",
  check: "✓",
  warn: "⚠",
  cross: "✖",
  arrow: "→",
  rule: "─",
  em: "—",
});

export type GlyphState = "ok" | "info" | "warn" | "danger" | "idle";

const glyphTone: Record<GlyphState, Tone> = {
  ok: "brand",
  info: "info",
  warn: "warn",
  danger: "danger",
  idle: "ghost",
};

export const glyph = (state: GlyphState): string => {
  const character =
    state === "ok"
      ? GLYPHS.check
      : state === "warn"
        ? GLYPHS.warn
        : state === "danger"
          ? GLYPHS.cross
          : state === "info"
            ? GLYPHS.arrow
            : GLYPHS.item;
  return paint(character, glyphTone[state]);
};

export const banner = (
  title?: string,
  tagline = "Secure environment relay",
): string => {
  const lines = [`${paint(GLYPHS.dot, "brand")}  ${bold("DotRelay")}`];
  if (title !== undefined) lines.push(`  ${bold(title)}`);
  if (tagline) lines.push(`  ${paint(tagline, "faint")}`);
  return lines.join("\n");
};

export const heading = (command: string, context?: string): string =>
  `  ${bold(`dotrelay ${command}`)}${
    context ? `  ${paint(`— ${context}`, "faint")}` : ""
  }`;

export const section = (title: string, tone: Tone = "info"): string =>
  `  ${paint(title, tone)}`;

export type KvRow = Readonly<{
  readonly key: string;
  readonly value?: string | undefined;
  readonly tone?: Tone | undefined;
}>;

export const kv = (rows: readonly KvRow[], keyWidth = 16): string =>
  rows
    .map((row) => {
      const key = pad(truncate(row.key, keyWidth), keyWidth);
      const value = row.value ?? paint(GLYPHS.em, "ghost");
      return `  ${paint(key, "faint")} ${paint(value, row.tone ?? "fg")}`;
    })
    .join("\n");

export type TableCell = string | null;

export const table = (
  headers: readonly string[],
  rows: readonly TableCell[][],
  tones?: readonly (readonly (Tone | undefined)[])[],
  width = terminalWidth(),
): string => {
  let widths = headers.map((header, column) =>
    Math.max(
      visibleWidth(header),
      ...rows.map((row) => visibleWidth(row[column] ?? GLYPHS.em)),
    ),
  );
  const cap = Math.min(width - 4, 100);
  for (;;) {
    const total = widths.reduce((sum, w) => sum + w + 2, -2);
    if (total <= cap) break;
    let widest = 0;
    for (let i = 1; i < widths.length; i++)
      if ((widths[i] ?? 0) > (widths[widest] ?? 0)) widest = i;
    if ((widths[widest] ?? 0) <= 4) break;
    widths = widths.map((w, i) => (i === widest ? w - 1 : w));
  }
  const cells = (row: readonly TableCell[], rowIndex: number): string[] =>
    row.map((cell, column) => {
      const tone = tones?.[rowIndex]?.[column] ?? "fg";
      const text = truncate(cell ?? GLYPHS.em, widths[column] ?? 2);
      return pad(paint(text, tone), widths[column] ?? 2);
    });
  const head = headers
    .map((header, column) =>
      pad(
        paint(truncate(header, widths[column] ?? 2), "faint"),
        widths[column] ?? 2,
      ),
    )
    .join("  ");
  const lines = [
    head,
    ...rows.map((row, i) => `  ${cells(row, i).join("  ")}`),
  ];
  return lines.map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
};

export const rule = (tone: Tone = "ghost", length?: number): string => {
  const width = length ?? Math.max(24, Math.min(terminalWidth() - 4, 56));
  return paint(GLYPHS.rule.repeat(width), tone);
};

export type ReviewOptions = Readonly<{
  readonly title: string;
  readonly body: string;
  readonly question: string;
  readonly danger?: boolean;
  readonly width?: number;
}>;

export const reviewFrame = ({
  title,
  body,
  question,
  danger = false,
  width = terminalWidth(),
}: ReviewOptions): string => {
  const tone: Tone = danger ? "danger" : "ghost";
  const bodyLines = body.split("\n");
  const content = [
    `  ${bold(title, danger ? "danger" : "fg")}`,
    "",
    ...bodyLines.map((line) => (line.length > 0 ? `  ${line}` : "")),
    "",
    `  ${question}`,
  ];
  const longest = Math.max(
    visibleWidth(`  ${title}`),
    visibleWidth(`  ${question}`),
    ...bodyLines.map((line) =>
      line.length > 0 ? visibleWidth(`  ${line}`) : 0,
    ),
  );
  const ruleLength = Math.max(
    24,
    Math.min(width - 4, Math.max(40, longest + 4)),
  );
  return [rule(tone, ruleLength), ...content, rule(tone, ruleLength)].join(
    "\n",
  );
};

export const stepLine = (label: string, state: GlyphState = "ok"): string =>
  `  ${glyph(state)} ${paint(label, state === "idle" ? "muted" : "fg")}`;

export const stepDone = (label: string): string => stepLine(label, "ok");
export const stepFail = (label: string): string => stepLine(label, "danger");

export const epilogue = (text: string, tone: Tone = "brand"): string =>
  `  ${paint(text, tone)}`;

export const note = (text: string, tone: Tone = "faint"): string =>
  `  ${paint(GLYPHS.item, "ghost")}  ${paint(text, tone)}`;

export type StatusFooter = Readonly<{
  readonly state: GlyphState;
  readonly text: string;
}>;

export const statusCard = (
  rows: readonly KvRow[],
  footer?: StatusFooter,
  title = "status",
): string =>
  [
    banner(title),
    "",
    kv(rows),
    ...(footer
      ? [
          "",
          `  ${glyph(footer.state)}  ${
            footer.state === "ok" ? paint(footer.text, "brand") : footer.text
          }`,
        ]
      : []),
    "",
  ].join("\n");

export type ErrorCard = Readonly<{
  readonly title: string;
  readonly detail: string;
  readonly fixes?: readonly string[];
}>;

export const errorCard = ({ title, detail, fixes = [] }: ErrorCard): string =>
  [
    `  ${glyph("danger")}  ${bold(title, "danger")}`,
    "",
    `     ${detail}`,
    ...(fixes.length > 0
      ? ["", ...fixes.map((fix) => `  ${glyph("info")}  ${fix}`)]
      : []),
    "",
  ].join("\n");

export const commandRow = (
  command: string,
  description: string,
  commandWidth = 22,
  width = terminalWidth(),
): string =>
  `  ${bold(pad(truncate(command, commandWidth), commandWidth))} ${paint(
    truncate(description, Math.max(12, width - 4 - commandWidth - 2)),
    "muted",
  )}`;

export type SelectionRow = Readonly<{
  readonly label: string;
  readonly detail?: string | undefined;
}>;

export const selectionTitle = (title: string): string => `  ${bold(title)}`;

export const selectionRow = (row: SelectionRow, cursor: boolean): string => {
  const marker = cursor
    ? paint(GLYPHS.cursor, "brand")
    : paint(GLYPHS.item, "ghost");
  const label = cursor ? bold(row.label) : paint(row.label, "muted");
  const detail = row.detail ? paint(row.detail, "faint") : "";
  return `    ${marker}  ${label}${detail ? `  ${detail}` : ""}`;
};

export const selectionHint = (interactive: boolean): string =>
  `     ${paint(
    interactive ? "↑↓ navigate · Enter select · Esc cancel" : "Enter a number",
    "faint",
  )}`;

export const numberedRow = (index: number, row: SelectionRow): string =>
  `    ${pad(`${index}.`, 3)}  ${paint(row.label, "muted")}${
    row.detail ? `  ${paint(row.detail, "faint")}` : ""
  }`;

export const numberedHint = (allowsDefault: boolean): string =>
  `     ${paint(
    allowsDefault
      ? "Enter a number, or press Enter for the first option"
      : "Enter a number",
    "faint",
  )}`;

// A confirmation question may carry the typed-answer hint ("Publish? [y/N]");
// the boxed Yes/No choice replaces that hint, so it is stripped for display.
export const stripConfirmSuffix = (question: string): string =>
  question.replace(/\s*\[[yY]\/[nN]\]\s*$/, "").trimEnd();

export const confirmHint = (): string =>
  `     ${paint("↑↓ navigate · Enter confirm · Esc decline", "faint")}`;

export const confirmRows = (cursor: number): string =>
  [
    selectionRow({ label: "Yes" }, cursor === 0),
    selectionRow({ label: "No" }, cursor === 1),
  ].join("\n");

export const confirmBox = (
  question: string,
  cursor: number,
  width = terminalWidth(),
): string => {
  const lines = stripConfirmSuffix(question)
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${bold(line)}` : ""));
  const rows = confirmRows(cursor);
  const longest = Math.max(
    ...lines.map((line) => visibleWidth(line)),
    visibleWidth(rows),
  );
  const ruleLength = Math.max(24, Math.min(width - 4, longest + 2));
  return [
    rule("ghost", ruleLength),
    ...lines,
    "",
    rows,
    "",
    rule("ghost", ruleLength),
    confirmHint(),
  ].join("\n");
};

export const confirmResult = (question: string, accepted: boolean): string =>
  `  ${glyph(accepted ? "ok" : "danger")}  ${
    accepted ? paint("Confirmed", "brand") : paint("Declined", "danger")
  }  ${paint(stripConfirmSuffix(question), "muted")}`;
