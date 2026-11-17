import { sanitizeCliLine, sanitizeCliText } from "./errors";
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

// The CLI draws each run along a rail down the left edge: a header opens
// it, every step hangs off it, and the result closes it.
//
//   ┌  dotrelay pull
//   │
//   ◇  Signed in as maya                 3.8s
//   ▲  This device needs your account key
//   │  Send it from a browser you already use.
//   ◆  Get the key
//   │  ● From my browser   ○ Recovery code
//   └  .env · 14 values
export const GLYPHS = Object.freeze({
  top: "┌",
  bar: "│",
  end: "└",
  done: "◇",
  active: "◆",
  warn: "▲",
  fail: "■",
  on: "●",
  off: "○",
  item: "·",
  arrow: "→",
  em: "—",
});

export type GlyphState = "ok" | "info" | "warn" | "danger" | "idle";

const glyphFor: Record<GlyphState, readonly [string, Tone]> = {
  ok: [GLYPHS.done, "brand"],
  info: [GLYPHS.active, "brand"],
  warn: [GLYPHS.warn, "warn"],
  danger: [GLYPHS.fail, "danger"],
  idle: [GLYPHS.bar, "ghost"],
};

export const glyph = (state: GlyphState): string => {
  const [character, tone] = glyphFor[state];
  return paint(character, tone);
};

/** The rail on its own, for a spacer line. */
export const bar = (): string => paint(GLYPHS.bar, "ghost");

// Text on the rail wraps at the terminal width so a narrow terminal never
// breaks the rail. A word longer than the room (a URL) stays whole so it
// can still be copied.
const wrapToWidth = (text: string, room: number): string[] => {
  const rows: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (visibleWidth(paragraph) <= room) {
      rows.push(paragraph);
      continue;
    }
    // A numbered or bulleted step wraps under its own text, not its number.
    const hang = " ".repeat(
      /^(\d+\.\s|[-•]\s)/.exec(paragraph)?.[0].length ?? 0,
    );
    let current = "";
    for (const word of paragraph.split(" ")) {
      if (current.length === 0) current = word;
      else if (visibleWidth(current) + 1 + visibleWidth(word) <= room)
        current = `${current} ${word}`;
      else {
        rows.push(current);
        current = `${hang}${word}`;
      }
    }
    rows.push(current);
  }
  return rows;
};

const railRoom = (width: number): number => Math.max(20, width - 4);

/** One or more lines of text hanging off the rail. */
export const railText = (
  text: string,
  tone: Tone = "muted",
  width = terminalWidth(),
): string =>
  wrapToWidth(text, railRoom(width))
    .map((row) =>
      row.length === 0
        ? bar()
        : `${bar()}  ${tone === "fg" ? row : paint(row, tone)}`,
    )
    .join("\n");

/** Already-styled lines, each prefixed with the rail. */
export const railLines = (text: string): string =>
  text
    .split("\n")
    .map((row) =>
      row.trim().length === 0 ? bar() : `${bar()}  ${row.replace(/^ {2}/, "")}`,
    )
    .join("\n");

/** A line with a marker, text, and an optional right-aligned note. */
export const markLine = (
  state: GlyphState,
  text: string,
  aside?: string,
  width = terminalWidth(),
): string => {
  const [first = "", ...rest] = wrapToWidth(text, railRoom(width));
  const head = `${glyph(state)}  ${first}`;
  const withAside =
    aside && rest.length === 0 && width >= 60
      ? (() => {
          const gap = width - 2 - visibleWidth(head) - visibleWidth(aside);
          return gap > 1
            ? `${head}${" ".repeat(gap)}${paint(aside, "faint")}`
            : head;
        })()
      : head;
  return [withAside, ...rest.map((row) => `${bar()}  ${row}`)].join("\n");
};

/** Seconds with one decimal, for the timing beside a finished step. */
export const elapsed = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Opens a run: `┌  dotrelay pull` with the context on the right. */
export const heading = (command: string, context?: string): string => {
  const head = `${paint(GLYPHS.top, "ghost")}  ${bold(`dotrelay ${command}`)}`;
  if (!context) return head;
  const width = terminalWidth();
  const tail = sanitizeCliLine(context);
  const gap = width - 2 - visibleWidth(head) - visibleWidth(tail);
  return gap > 1 && width >= 60
    ? `${head}${" ".repeat(gap)}${paint(tail, "faint")}`
    : `${head}\n${bar()}  ${paint(tail, "faint")}`;
};

/** The header and the spacer line under it, ready to write. */
export const openRail = (command: string, context?: string): string =>
  `${heading(command, context)}\n${bar()}\n`;

/** The version banner shown above help. */
export const banner = (title?: string, tagline = ""): string => {
  const lines = [
    `${paint(GLYPHS.top, "ghost")}  ${bold("dotrelay")}${title ? `  ${paint(title, "muted")}` : ""}`,
  ];
  if (tagline) lines.push(`${bar()}  ${paint(tagline, "faint")}`);
  return lines.join("\n");
};

export const section = (title: string, tone: Tone = "info"): string =>
  `  ${paint(title, tone)}`;

export type KvRow = Readonly<{
  readonly key: string;
  readonly value?: string | undefined;
  readonly tone?: Tone | undefined;
}>;

// Row keys and values are plain text, often received from a server, so they
// are sanitized here before the card applies its own styling. Rows carry a
// two-space indent; railLines swaps it for the rail.
export const kv = (rows: readonly KvRow[], keyWidth = 12): string =>
  rows
    .map((row) => {
      const key = pad(truncate(sanitizeCliLine(row.key), keyWidth), keyWidth);
      const value =
        row.value === undefined
          ? paint(GLYPHS.em, "ghost")
          : sanitizeCliLine(row.value);
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
  const cap = Math.min(width - 5, 100);
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
    `  ${head}`,
    ...rows.map((row, i) => `  ${cells(row, i).join("  ")}`),
  ];
  return lines.map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
};

export const rule = (tone: Tone = "ghost", length?: number): string => {
  const width = length ?? Math.max(24, Math.min(terminalWidth() - 4, 56));
  return paint("─".repeat(width), tone);
};

export type ReviewOptions = Readonly<{
  readonly title: string;
  readonly body: string;
  readonly question: string;
  readonly danger?: boolean;
  readonly width?: number;
}>;

/**
 * A change preview that ends in a question. The question line is the
 * active step; the confirm prompt drawn under it answers it.
 */
export const reviewFrame = ({
  title,
  body,
  question,
  danger = false,
}: ReviewOptions): string =>
  [
    danger
      ? markLine("warn", bold(title, "danger")).replace(
          glyph("warn"),
          paint(GLYPHS.warn, "danger"),
        )
      : markLine("ok", bold(title)),
    bar(),
    railLines(body),
    bar(),
    // The [y/N] hint stays: a terminal without raw mode answers by typing.
    markLine("info", question),
  ].join("\n");

export const stepLine = (
  label: string,
  state: GlyphState = "ok",
  ms?: number,
): string =>
  markLine(
    state,
    paint(label, state === "idle" ? "muted" : "fg"),
    ms === undefined ? undefined : elapsed(ms),
  );

export const stepDone = (label: string, ms?: number): string =>
  stepLine(label, "ok", ms);
export const stepFail = (label: string): string => stepLine(label, "danger");

/** Closes a run: `└  text`. */
export const epilogue = (text: string, tone: Tone = "brand"): string =>
  `${paint(GLYPHS.end, "ghost")}  ${paint(text, tone)}`;

// Notes often name Variables or carry server text, so control sequences are
// stripped before the text reaches the terminal. A warning note is marked
// so it stands out from the rail.
export const note = (text: string, tone: Tone = "faint"): string =>
  tone === "warn" || tone === "danger"
    ? markLine(
        tone === "warn" ? "warn" : "danger",
        paint(sanitizeCliText(text), tone),
      )
    : railText(sanitizeCliText(text), tone);

export type StatusFooter = Readonly<{
  readonly state: GlyphState;
  readonly text: string;
}>;

export const statusCard = (
  rows: readonly KvRow[],
  footer?: StatusFooter,
  title = "status",
  context?: string,
): string =>
  [
    heading(title, context),
    bar(),
    railLines(kv(rows)),
    ...(footer ? [bar(), markLine(footer.state, footer.text)] : []),
  ].join("\n");

export type ErrorCard = Readonly<{
  readonly title: string;
  readonly detail: string;
  readonly fixes?: readonly string[];
  /** The exact command that moves things forward, when there is one. */
  readonly next?: string | undefined;
}>;

export const errorCard = ({
  title,
  detail,
  fixes = [],
  next,
}: ErrorCard): string =>
  [
    markLine("danger", bold(title, "danger")),
    railText(detail, "fg"),
    ...fixes.map((fix) => railText(fix, "muted")),
    ...(next
      ? [
          bar(),
          `${paint(GLYPHS.end, "ghost")}  ${paint("next", "faint")}  ${bold(next)}`,
        ]
      : [`${paint(GLYPHS.end, "ghost")}`]),
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

/** The question of an open prompt: the active marker and the question. */
export const selectionTitle = (title: string): string =>
  markLine("info", sanitizeCliLine(title));

// Selection labels and details are plain text, often server-supplied names
// (Teams, Projects, Environments), so they are sanitized before styling.
export const selectionRow = (row: SelectionRow, cursor: boolean): string => {
  const marker = cursor
    ? paint(GLYPHS.on, "brand")
    : paint(GLYPHS.off, "faint");
  const text = sanitizeCliLine(row.label);
  const label = cursor ? text : paint(text, "muted");
  const detail = row.detail ? paint(sanitizeCliLine(row.detail), "faint") : "";
  return `${bar()}  ${marker} ${label}${detail ? `  ${detail}` : ""}`;
};

export const selectionHint = (interactive: boolean): string =>
  `${bar()}  ${paint(interactive ? "↑↓ enter" : "Enter a number", "ghost")}`;

export const numberedRow = (index: number, row: SelectionRow): string =>
  `${bar()}  ${pad(`${index}.`, 3)} ${paint(sanitizeCliLine(row.label), "muted")}${
    row.detail ? `  ${paint(sanitizeCliLine(row.detail), "faint")}` : ""
  }`;

export const numberedHint = (allowsDefault: boolean): string =>
  `${bar()}  ${paint(
    allowsDefault
      ? "Enter a number, or press Enter for the first option"
      : "Enter a number",
    "faint",
  )}`;

/** A settled prompt: `◇  Question  answer`, then the rail. */
export const selectionResult = (title: string, answer: string): string =>
  `${markLine("ok", `${sanitizeCliLine(title)} ${paint(sanitizeCliLine(answer), "faint")}`)}\n${bar()}`;

// A confirmation question may carry the typed-answer hint ("Publish? [y/N]");
// the toggle replaces that hint, so it is stripped for display.
export const stripConfirmSuffix = (question: string): string =>
  question.replace(/\s*\[[yY]\/[nN]\]\s*$/, "").trimEnd();

export const confirmHint = (): string =>
  `${bar()}  ${paint("←→ enter · y/n", "ghost")}`;

/** A one-line toggle: `●  Yes   ○  No`. */
export const confirmRows = (
  cursor: number,
  labels: readonly [string, string] = ["Yes", "No"],
): string =>
  `${bar()}  ${labels
    .map((label, index) =>
      index === cursor
        ? `${paint(GLYPHS.on, "brand")} ${label}`
        : paint(`${GLYPHS.off} ${label}`, "faint"),
    )
    .join("   ")}`;

export const confirmBox = (
  question: string,
  cursor: number,
  labels?: readonly [string, string],
): string =>
  [
    ...stripConfirmSuffix(question)
      .split("\n")
      .map((line, index) =>
        index === 0
          ? markLine("info", line)
          : line.length > 0
            ? railText(line, "fg")
            : bar(),
      ),
    confirmRows(cursor, labels),
    confirmHint(),
  ].join("\n");

export const confirmResult = (
  question: string,
  accepted: boolean,
  labels?: readonly [string, string],
): string => {
  const shown = stripConfirmSuffix(question).split("\n")[0] ?? "";
  // A declined Yes/No approval is marked; turning down an offer with its
  // own labels ("Not now") is a choice, not a failure.
  const declinedMark = labels === undefined ? "danger" : "ok";
  const [yes, no] = labels ?? ["Yes", "No"];
  return `${markLine(
    accepted ? "ok" : declinedMark,
    `${shown} ${paint(accepted ? yes : no, accepted || labels ? "faint" : "danger")}`,
  )}\n${bar()}`;
};
