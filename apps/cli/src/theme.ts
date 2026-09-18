export type Tone =
  | "brand"
  | "info"
  | "warn"
  | "danger"
  | "accent"
  | "fg"
  | "muted"
  | "faint"
  | "ghost";

type Level = "off" | "256" | "truecolor";

const TRUECOLOR: Record<Tone, string> = {
  brand: "105 225 136",
  info: "54 165 215",
  warn: "224 159 69",
  danger: "251 103 92",
  accent: "169 121 193",
  fg: "231 237 233",
  muted: "148 158 152",
  faint: "108 116 111",
  ghost: "73 79 75",
};

const INDEXED: Record<Tone, string> = {
  brand: "38;5;82",
  info: "38;5;38",
  warn: "38;5;214",
  danger: "38;5;203",
  accent: "38;5;141",
  fg: "38;5;252",
  muted: "38;5;250",
  faint: "38;5;244",
  ghost: "38;5;240",
};

const detectLevel = (): Level => {
  if (process.env.NO_COLOR !== undefined || process.env.CI !== undefined)
    return "off";
  if (!process.stderr.isTTY && !process.stdout.isTTY) return "off";
  const term = process.env.COLORTERM ?? "";
  if (term.includes("truecolor") || term.includes("24bit")) return "truecolor";
  return "256";
};

let level: Level = detectLevel();

export const setToneLevel = (next: Level): void => {
  level = next;
};

export const colorLevel = (): Level => level;

export const paint = (text: string, tone: Tone = "fg"): string => {
  if (level === "off") return text;
  const spec =
    level === "truecolor" ? `38;2;${TRUECOLOR[tone]}` : INDEXED[tone];
  return `\x1b[${spec}m${text}\x1b[0m`;
};

export const bold = (text: string, tone: Tone = "fg"): string =>
  level === "off" ? text : `\x1b[1m${paint(text, tone)}\x1b[22m`;

export const dim = (text: string): string => paint(text, "faint");

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export const visibleWidth = (text: string): number => {
  const stripped = text.replace(ANSI, "");
  let width = 0;
  for (const character of stripped) {
    const code = character.codePointAt(0) ?? 0;
    width +=
      code >= 0x1100 &&
      (code <= 0x115f ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0x20000 && code <= 0x3fffd))
        ? 2
        : 1;
  }
  return width;
};

export const pad = (text: string, width: number): string => {
  const gap = width - visibleWidth(text);
  return gap > 0 ? `${text}${" ".repeat(gap)}` : text;
};

const isWide = (code: number): boolean =>
  code >= 0x1100 &&
  (code <= 0x115f ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x20000 && code <= 0x3fffd));

export const truncate = (text: string, width: number): string => {
  if (visibleWidth(text) <= width) return text;
  const characters: string[] = [];
  let used = 0;
  for (const character of text) {
    const w = isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
    if (used + w > width - 1) break;
    characters.push(character);
    used += w;
  }
  return `${characters.join("")}…`;
};

export const terminalWidth = (): number => {
  const columns = process.stderr.columns ?? process.stdout.columns ?? 80;
  return columns > 0 ? columns : 80;
};
