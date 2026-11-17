// PROTOTYPE. Try a direction in your own terminal:
//
//   bun apps/cli/prototypes/run.ts                 pick from a menu
//   bun apps/cli/prototypes/run.ts live push       one scene
//   bun apps/cli/prototypes/run.ts plan all --auto play every scene hands-free
//
// Flags: --auto (answers prompts for you), --width <n> (pretend the terminal
// is n columns), --no-input (what scripts and CI see). NO_COLOR is honoured.

import { SCENES, type SceneId } from "./data";
import { createCtx, pick } from "./kit";
import { DIRECTIONS, type DirectionId } from "./directions";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const widthIndex = argv.indexOf("--width");
const width =
  widthIndex >= 0 ? Number(argv[widthIndex + 1]) : process.stdout.columns || 80;
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && argv[i - 1] !== "--width",
);

const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const ctx = createCtx({
  width: Math.min(width, 100),
  color: process.env.NO_COLOR === undefined && process.stdout.isTTY === true,
  tty: process.stdout.isTTY === true,
  noInput: flag("--no-input") || !tty,
  auto: flag("--auto"),
});

const choose = async (
  title: string,
  options: readonly { label: string; detail: string }[],
): Promise<number> =>
  await pick(
    createCtx({
      width: ctx.width,
      color: ctx.color,
      tty: true,
      noInput: false,
      auto: false,
    }),
    options.length,
    0,
    (cursor) =>
      [
        `  ${ctx.bold(title)}`,
        ...options.map(
          (o, i) =>
            `  ${i === cursor ? ctx.paint("›", "green") : " "} ${i === cursor ? ctx.paint(o.label, "green") : o.label}  ${ctx.paint(o.detail, "faint")}`,
        ),
      ].join("\n"),
    (i) => `  ${title} ${ctx.paint(options[i]?.label ?? "", "green")}`,
  );

let direction = positional[0] as DirectionId | undefined;
let scene = positional[1] as SceneId | "all" | undefined;

if (!direction || !(direction in DIRECTIONS)) {
  if (!tty) {
    console.error(
      "usage: bun apps/cli/prototypes/run.ts <quiet|live|plan> <scene|all> [--auto] [--width n] [--no-input]",
    );
    process.exit(2);
  }
  const ids = Object.keys(DIRECTIONS) as DirectionId[];
  console.log();
  const i = await choose(
    "Direction",
    ids.map((id) => ({
      label: DIRECTIONS[id].title,
      detail: DIRECTIONS[id].about,
    })),
  );
  direction = ids[i];
}
if (!scene || (scene !== "all" && !SCENES.some((s) => s.id === scene))) {
  if (!tty) scene = "ci";
  else {
    const options = [
      ...SCENES.map((s) => ({ label: s.id, detail: s.title })),
      { label: "all", detail: "every scene in a row" },
    ];
    const i = await choose("Scene", options);
    scene = (options[i]?.label ?? "first-run") as SceneId | "all";
  }
}

const chosen = DIRECTIONS[direction as DirectionId];
// Without a terminal to prompt on, every scene behaves like the CI scene:
// it fails with a stable code and the exact next command.
const order: SceneId[] = !ctx.interactive
  ? ["ci"]
  : scene === "all"
    ? SCENES.map((s) => s.id)
    : [scene as SceneId];
let exit = 0;
if (ctx.tty) process.stdout.write("\x1b[?25l");
try {
  for (const id of order) {
    console.log();
    exit = await chosen.scenes[id](ctx);
    if (order.length > 1) await ctx.sleep(1200);
  }
} finally {
  if (ctx.tty) process.stdout.write("\x1b[?25h");
}
process.exit(exit);
