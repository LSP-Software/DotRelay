// PROTOTYPE. Records every direction × scene × width × colour hands-free
// (on a virtual clock, so it takes a second) and writes a self-contained
// player page:
//
//   bun apps/cli/prototypes/record.ts   →   apps/cli/prototypes/out/gallery.html

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SCENES } from "./data";
import { DIRECTIONS, type DirectionId } from "./directions";
import { createCtx, type Recording } from "./kit";

const WIDTHS = [80, 46] as const;
const casts: Record<
  string,
  {
    width: number;
    rows: number;
    events: [number, string][];
    exit: number;
    marks: number[];
  }
> = {};

for (const direction of Object.keys(DIRECTIONS) as DirectionId[])
  for (const scene of SCENES)
    for (const width of WIDTHS)
      for (const color of [true, false]) {
        const record: Recording = {
          width,
          events: [],
          lines: 0,
          peak: 0,
          marks: [],
        };
        const ctx = createCtx({
          width,
          color,
          tty: true,
          noInput: false,
          auto: true,
          record,
        });
        const exit = await DIRECTIONS[direction].scenes[scene.id](ctx);
        await ctx.sleep(1500);
        casts[`${direction}/${scene.id}/${width}/${color ? "color" : "mono"}`] =
          {
            width,
            rows: record.peak + 1,
            events: record.events.map(([t, d]) => [
              Math.round(t * 100) / 100,
              d,
            ]),
            exit,
            marks: record.marks,
          };
      }

const meta = {
  directions: Object.fromEntries(
    Object.entries(DIRECTIONS).map(([id, d]) => [
      id,
      { title: d.title, about: d.about },
    ]),
  ),
  scenes: SCENES,
};

const template = await Bun.file(
  join(import.meta.dir, "gallery.template.html"),
).text();
const screenJs = await Bun.file(join(import.meta.dir, "screen.js")).text();
const page = template
  .replace("/*SCREEN*/", () => screenJs)
  .replace(/\/\*CASTS\*\/\s*null/, () =>
    JSON.stringify(casts).replace(/</g, "\\u003c"),
  )
  .replace(/\/\*META\*\/\s*null/, () => JSON.stringify(meta));
await mkdir(join(import.meta.dir, "out"), { recursive: true });
const target = join(import.meta.dir, "out", "gallery.html");
await Bun.write(target, page);
console.log(
  `${Object.keys(casts).length} recordings, ${(page.length / 1024).toFixed(0)} KB → ${target}`,
);

// Static sheets for screenshots: for each scene, the three directions side
// by side at a key moment (a prompt waiting) and at the end.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createScreen } = require("./screen.js") as {
  createScreen: () => { feed: (d: string) => void; html: () => string };
};
const snapshot = (key: string, upTo?: number): string => {
  const cast = casts[key];
  if (!cast) return "";
  const screen = createScreen();
  for (const [, data] of cast.events.slice(0, upTo ?? cast.events.length))
    screen.feed(data);
  return screen.html().replace(/^\n+/, "").replace(/\s+$/, "");
};
const MOMENT: Record<string, "first" | "last" | "none"> = {
  "first-run": "first",
  "signed-out": "first",
  push: "last",
  status: "first",
  failure: "first",
  ci: "none",
};
const sheetCss = `
  .grid{display:flex;flex-direction:column;gap:14px;font-family:var(--font-sans)}
  h2{font-size:13px;font-weight:600;margin:6px 0 2px;color:var(--foreground)}
  .label{font-size:12px;color:var(--muted-foreground);margin:0 0 4px}
  pre{margin:0;padding:16px;border-radius:var(--radius);background:rgb(6,10,8);color:rgb(231,237,233);
      font-family:var(--font-mono);font-size:12.5px;line-height:1.45;white-space:pre;overflow-x:auto;border:1px solid var(--border)}
  .narrow pre{width:fit-content}
`;
const sheets: string[] = [];
for (const scene of SCENES) {
  const blocks: string[] = [];
  for (const direction of Object.keys(DIRECTIONS) as DirectionId[]) {
    const key = `${direction}/${scene.id}/80/color`;
    const cast = casts[key];
    const which = MOMENT[scene.id];
    const mark =
      which === "first"
        ? cast?.marks[0]
        : which === "last"
          ? cast?.marks.at(-1)
          : undefined;
    const title = DIRECTIONS[direction].title;
    if (mark !== undefined)
      blocks.push(
        `<p class="label">${title} · waiting on you</p><pre>${snapshot(key, mark)}</pre>`,
      );
    blocks.push(
      `<p class="label">${title}${mark !== undefined ? " · end" : ""}</p><pre>${snapshot(key)}</pre>`,
    );
  }
  const html = `<!doctype html><meta charset="utf-8"><style>${sheetCss}</style><div class="grid"><h2>${scene.title}</h2>${blocks.join("")}</div>`;
  const file = join(import.meta.dir, "out", `sheet-${scene.id}.html`);
  await Bun.write(file, html);
  sheets.push(file);
}
const narrow = (Object.keys(DIRECTIONS) as DirectionId[])
  .map(
    (d) =>
      `<p class="label">${DIRECTIONS[d].title} · 46 columns, NO_COLOR</p><pre>${snapshot(`${d}/push/46/mono`)}</pre>`,
  )
  .join("");
await Bun.write(
  join(import.meta.dir, "out", "sheet-narrow.html"),
  `<!doctype html><meta charset="utf-8"><style>${sheetCss}</style><div class="grid narrow"><h2>push at 46 columns with NO_COLOR</h2>${narrow}</div>`,
);
console.log(`sheets → ${join(import.meta.dir, "out")}`);
