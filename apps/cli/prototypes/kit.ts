// PROTOTYPE. Throwaway terminal kit for the CLI redesign directions.
// No real server calls, no state on disk. Delete once a direction is chosen.

export type Tone =
  "green" | "amber" | "red" | "fg" | "muted" | "faint" | "ghost" | "blue";

const RGB: Record<Tone, string> = {
  green: "101;226;135", // oklch(0.82 0.17 150), the web primary
  amber: "250;187;65",
  red: "250;105;92", // oklch(0.7 0.18 28), the web destructive
  fg: "231;237;233",
  muted: "148;158;152",
  faint: "110;118;113",
  ghost: "62;69;65",
  blue: "120;180;230",
};

export type Key = "enter" | "up" | "down" | "left" | "right" | "esc" | string;

export type Ctx = Readonly<{
  width: number;
  narrow: boolean;
  color: boolean;
  tty: boolean;
  interactive: boolean;
  auto: boolean;
  paint: (text: string, tone: Tone) => string;
  bold: (text: string) => string;
  write: (text: string) => void;
  line: (text?: string) => void;
  sleep: (ms: number) => Promise<void>;
  key: (auto: Key) => Promise<Key>;
  rawKey: () => Promise<string>;
  typeLine: (auto: string, mask?: boolean) => Promise<string>;
  live: () => Live;
  shell: (command: string) => Promise<void>;
  wrap: (text: string, indent: number, width?: number) => string;
}>;

export type Live = Readonly<{
  set: (text: string) => void;
  keep: (text: string) => void;
}>;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
export const visible = (text: string): number =>
  [...text.replace(ANSI, "")].length;

// Wraps one line that is wider than the terminal at its last fitting space.
// Continuation rows keep the line's indent and any rail ("│") it starts
// with. A line with no space to break at (a URL, JSON) is left alone.
const reflowLine = (line: string, width: number): string => {
  const plain = line.replace(ANSI, "");
  if ([...plain].length <= width || plain.startsWith("{")) return line;
  const lead =
    /^(\s*(?:[│|]\s+|[^\sA-Za-z0-9.$[{"]+\s+)?)/.exec(plain)?.[1] ?? "";
  const indent = [...lead]
    .map((ch) => (ch === "│" || ch === "|" ? ch : " "))
    .join("");
  const rows: string[] = [];
  let rest = line;
  let first = true;
  for (;;) {
    const room = width - (first ? 0 : indent.length);
    let col = 0;
    let lastSpace = -1;
    let cut = -1;
    for (let i = 0; i < rest.length;) {
      const esc = /^\x1b\[[0-9;]*[A-Za-z]/.exec(rest.slice(i));
      if (esc) {
        i += esc[0].length;
        continue;
      }
      const ch = String.fromCodePoint(rest.codePointAt(i) ?? 32);
      if (ch === " " && col > [...lead].length) lastSpace = i;
      col += 1;
      if (col > room) {
        cut = lastSpace;
        break;
      }
      i += ch.length;
    }
    if (cut <= 0) {
      rows.push(first ? rest : `${indent}${rest}`);
      break;
    }
    rows.push(first ? rest.slice(0, cut) : `${indent}${rest.slice(0, cut)}`);
    rest = rest.slice(cut + 1);
    first = false;
  }
  return rows.join("\n");
};

export const reflow = (text: string, width: number): string =>
  text
    .split("\n")
    .map((line) => reflowLine(line, width))
    .join("\n");

export type Recording = {
  width: number;
  events: [number, string][];
  lines: number;
  peak: number;
  /** Event counts at each moment the run waited on a keypress. */
  marks: number[];
};

type Options = Readonly<{
  width: number;
  color: boolean;
  tty: boolean;
  noInput: boolean;
  auto: boolean;
  record?: Recording;
}>;

const rawChunk = async (): Promise<string> => {
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  const chunk = await new Promise<string>((resolve) =>
    stdin.once("data", (data) => resolve(data.toString("utf8"))),
  );
  stdin.setRawMode?.(false);
  stdin.pause();
  if (chunk === "\x03") {
    process.stdout.write("\x1b[?25h\n");
    process.exit(130);
  }
  return chunk;
};

const realKey = async (): Promise<Key> => {
  const chunk = await rawChunk();
  if (chunk === "\r" || chunk === "\n") return "enter";
  if (chunk === "\x1b[A") return "up";
  if (chunk === "\x1b[B") return "down";
  if (chunk === "\x1b[C") return "right";
  if (chunk === "\x1b[D") return "left";
  if (chunk === "\x1b") return "esc";
  return chunk.toLowerCase();
};

const realLine = async (): Promise<string> => {
  process.stdin.resume();
  const chunk = await new Promise<string>((resolve) =>
    process.stdin.once("data", (data) => resolve(data.toString("utf8"))),
  );
  process.stdin.pause();
  return chunk.replace(/\r?\n$/, "");
};

export const createCtx = (options: Options): Ctx => {
  const { record } = options;
  let clock = 0;
  const write = (text: string): void => {
    if (record) {
      record.events.push([clock / 1000, text]);
      record.lines += (text.match(/\n/g) ?? []).length;
      record.peak = Math.max(record.peak, record.lines);
    } else process.stdout.write(text);
  };
  const paint = (text: string, tone: Tone): string =>
    options.color ? `\x1b[38;2;${RGB[tone]}m${text}\x1b[39m` : text;
  const bold = (text: string): string =>
    options.color ? `\x1b[1m${text}\x1b[22m` : text;
  const sleep = async (ms: number): Promise<void> => {
    if (record) {
      clock += ms;
      return;
    }
    await Bun.sleep(ms);
  };
  const interactive = options.tty && !options.noInput;
  const key = async (auto: Key): Promise<Key> => {
    if (options.auto || record) {
      if (record && auto !== "down" && auto !== "up")
        record.marks.push(record.events.length);
      await sleep(auto === "down" || auto === "up" ? 260 : 650);
      return auto;
    }
    return await realKey();
  };
  const typeLine = async (auto: string, mask = false): Promise<string> => {
    if (options.auto || record) {
      await sleep(400);
      for (const character of auto) {
        write(mask ? "•" : character);
        await sleep(mask ? 18 : 35);
      }
      await sleep(250);
      write("\n");
      return auto;
    }
    return await realLine();
  };
  const live = (): Live => {
    let lines = 0;
    const clear = (): void => {
      if (lines > 0) {
        write(`\x1b[${lines}F\x1b[0J`);
        if (record) record.lines -= lines;
      }
    };
    const set = (text: string): void => {
      if (!options.tty) return;
      clear();
      const body = reflow(
        text.endsWith("\n") ? text : `${text}\n`,
        options.width,
      );
      write(body);
      lines = (body.match(/\n/g) ?? []).length;
    };
    const keep = (text: string): void => {
      if (options.tty) clear();
      lines = 0;
      if (text.length > 0)
        write(reflow(text.endsWith("\n") ? text : `${text}\n`, options.width));
    };
    return { set, keep };
  };
  const wrap = (
    text: string,
    indent: number,
    width = options.width,
  ): string => {
    const room = Math.max(20, width - indent - 1);
    const out: string[] = [];
    let current = "";
    for (const word of text.split(" ")) {
      if (current.length > 0 && visible(current) + 1 + visible(word) > room) {
        out.push(current);
        current = word;
      } else current = current.length > 0 ? `${current} ${word}` : word;
    }
    if (current.length > 0) out.push(current);
    return out.map((row) => `${" ".repeat(indent)}${row}`).join("\n");
  };
  const shell = async (command: string): Promise<void> => {
    write(paint("$ ", "faint"));
    if (options.auto || record) {
      await sleep(300);
      for (const character of command) {
        write(character);
        await sleep(28);
      }
      await sleep(350);
    } else write(command);
    write("\n");
  };
  return {
    width: options.width,
    narrow: options.width < 60,
    color: options.color,
    tty: options.tty,
    interactive,
    auto: options.auto || record !== undefined,
    paint,
    bold,
    write,
    line: (text = "") => write(`${reflow(text, options.width)}\n`),
    sleep,
    key,
    rawKey: rawChunk,
    typeLine,
    live,
    shell,
    wrap,
  };
};

/** Runs a picker: renders with a cursor, moves on arrows, returns on enter. */
export const pick = async (
  ctx: Ctx,
  count: number,
  autoIndex: number,
  render: (cursor: number) => string,
  settle: ((index: number) => string) | null,
  hotkeys: Readonly<Record<string, number>> = {},
  region: Live = ctx.live(),
  start = 0,
): Promise<number> => {
  let cursor = start;
  for (;;) {
    region.set(render(cursor));
    const next = await ctx.key(
      cursor < autoIndex ? "down" : cursor > autoIndex ? "up" : "enter",
    );
    if (next === "up" || next === "left") cursor = (cursor + count - 1) % count;
    else if (next === "down" || next === "right" || next === "\t")
      cursor = (cursor + 1) % count;
    else if (next === "enter") break;
    else if (hotkeys[next] !== undefined) {
      cursor = hotkeys[next] ?? cursor;
      break;
    }
  }
  if (settle) region.keep(settle(cursor));
  return cursor;
};

/** Reads a line inside a live region, redrawing on every keystroke. */
export const input = async (
  ctx: Ctx,
  auto: string,
  render: (text: string) => string,
  region: Live = ctx.live(),
): Promise<string> => {
  let text = "";
  region.set(render(text));
  if (ctx.auto) {
    await ctx.sleep(500);
    // A paste lands in one go; typing shows each character.
    text = auto;
    region.set(render(text));
    await ctx.sleep(500);
    return text;
  }
  for (;;) {
    const next = await ctx.rawKey();
    if (next === "\r" || next === "\n") return text;
    if (next === "\x7f" || next === "\b") text = text.slice(0, -1);
    else if (!next.startsWith("\x1b")) text += next.replace(/[\r\n]/g, "");
    region.set(render(text));
  }
};

/** A spinner that runs for `ms`, then settles to `done`. */
export const spin = async (
  ctx: Ctx,
  ms: number,
  frame: (tick: number, elapsedMs: number) => string,
  done: string,
): Promise<void> => {
  const region = ctx.live();
  const step = 90;
  for (let elapsed = 0, tick = 0; elapsed < ms; elapsed += step, tick += 1) {
    region.set(frame(tick, elapsed));
    await ctx.sleep(step);
  }
  region.keep(done);
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
