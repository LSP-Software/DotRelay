// PROTOTYPE. Direction A, "Quiet": plain sentences, almost no chrome.
// Reads like a person talking you through it. Colour only marks state.

import { D, type SceneId } from "./data";
import { type Ctx, pick, spin } from "./kit";

const I = "  ";

const dots = (tick: number): string =>
  ["·  ", "·· ", "···", " ··", "  ·", "   "][tick % 6] ?? "   ";

const mmss = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

const step = async (
  c: Ctx,
  ms: number,
  doing: string,
  done: string,
  clock = false,
): Promise<void> =>
  await spin(
    c,
    ms,
    (tick, elapsed) =>
      `${I}${c.paint(dots(tick), "green")} ${c.paint(doing, "muted")}${clock ? c.paint(`  ${mmss(elapsed)}`, "faint") : ""}`,
    `${I}${c.paint("✓", "green")}   ${done}`,
  );

const ok = (c: Ctx, text: string): void =>
  c.line(`${I}${c.paint("✓", "green")}   ${text}`);

const say = (
  c: Ctx,
  text: string,
  tone: "fg" | "muted" | "amber" = "fg",
): void => c.line(c.paint(c.wrap(text, 2), tone));

const yesNo = async (
  c: Ctx,
  question: string,
  def: "y" | "n",
  auto: "y" | "n",
): Promise<boolean> => {
  c.write(
    `${I}${question} ${c.paint(def === "y" ? "[Y/n]" : "[y/N]", "faint")} `,
  );
  for (;;) {
    const k = await c.key(auto);
    const answer = k === "enter" ? def : k;
    if (answer === "y" || answer === "n") {
      c.line(c.paint(answer === "y" ? "yes" : "no", "green"));
      return answer === "y";
    }
  }
};

const menu = async (
  c: Ctx,
  question: string,
  options: readonly { label: string; detail?: string }[],
  auto: number,
  remember?: string,
): Promise<number> => {
  const width = Math.max(...options.map((o) => o.label.length)) + 2;
  return await pick(
    c,
    options.length,
    auto,
    (cursor) =>
      [
        c.wrap(question, 2),
        ...options.map((o, i) => {
          const label = i === cursor ? c.paint(o.label, "green") : o.label;
          const detail =
            o.detail && !c.narrow
              ? c.paint(
                  `${" ".repeat(width - o.label.length)}${o.detail}`,
                  "faint",
                )
              : "";
          return `${I}${i === cursor ? c.paint("›", "green") : " "} ${label}${detail}`;
        }),
        c.paint(`${I}  ↑↓ to move, enter to choose`, "ghost"),
      ].join("\n"),
    (i) =>
      c.wrap(
        `${question} ${c.paint(options[i]?.label ?? "", "green")}${remember ? c.paint(`  ${remember}`, "faint") : ""}`,
        2,
      ),
  );
};

/** The fixed shape every non-interactive failure takes. */
const stop = (
  c: Ctx,
  message: string,
  code: string,
  exit: number,
  next: string,
): number => {
  c.line(`dotrelay: ${message}`);
  c.line(`  code  ${code}`);
  c.line(`  exit  ${exit}`);
  c.line(`  next  ${next}`);
  return exit;
};

const signIn = async (c: Ctx): Promise<void> => {
  c.line();
  c.line(`${I}Open  ${c.paint(D.verifyUrl, "blue")}`);
  c.line(`${I}Code  ${c.bold(D.userCode)}`);
  c.line();
  await step(
    c,
    3800,
    "Waiting for you in the browser (opened it for you)",
    `Signed in as ${c.bold(D.user)}`,
    true,
  );
};

const pull = async (c: Ctx, revision = D.revision): Promise<void> => {
  await step(
    c,
    1400,
    `Pulling ${D.env}`,
    `Wrote .env: ${D.pulled.total} values, ${D.pulled.team} Team and ${D.pulled.mine} Only me`,
  );
  void revision;
};

const firstRun = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay pull");
  c.line();
  say(
    c,
    "DotRelay isn't set up on this machine yet. A few steps first, then the pull.",
  );
  c.line();
  await menu(
    c,
    "Which server?",
    [
      { label: D.origin, detail: "hosted by DotRelay" },
      { label: "Another server", detail: "you'll type its address" },
    ],
    0,
  );
  await step(
    c,
    900,
    `Checking ${D.origin}`,
    `${D.origin} answered, server id ${D.serverId}`,
  );
  say(
    c,
    "From now on this machine only talks to that id at that address.",
    "muted",
  );
  await yesNo(c, "Trust it?", "y", "y");
  c.line();
  say(
    c,
    "Next, sign in with GitHub. It proves who you are and nothing else; it doesn't give this machine any keys.",
  );
  await signIn(c);
  ok(c, `Added this machine as a device, ${c.bold(D.device)}`);
  c.line();
  say(
    c,
    "This device can't read anything yet. It needs your account key from a device or browser you already use.",
  );
  c.line();
  const how = await menu(
    c,
    "How do you want to get it?",
    [
      {
        label: "From my browser",
        detail: "web app, Devices, send key to " + D.device,
      },
      { label: "With my recovery code", detail: "13 groups of 4" },
    ],
    0,
  );
  void how;
  c.write(`${I}Paste the transfer code: `);
  await c.typeLine(D.transferCode);
  await step(
    c,
    1100,
    "Opening the transfer",
    `Account key received. Fingerprint ${D.fingerprint} matches.`,
  );
  c.line();
  ok(c, `Found project ${c.bold(D.repo)} from the GitHub remote (origin)`);
  c.line();
  await menu(
    c,
    "Which environment?",
    D.envs.map((e) => ({ label: e.label, detail: e.detail })),
    0,
    "saved for this folder",
  );
  c.line();
  await pull(c);
  c.line();
  say(
    c,
    ".env isn't tracked by Git. From here on, dotrelay pull is all you need.",
    "muted",
  );
  return 0;
};

const signedOut = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay pull");
  c.line();
  say(c, `You're signed out of ${D.origin}. Your session expired.`, "amber");
  const go = await yesNo(c, "Sign in and carry on?", "y", "y");
  if (!go) return 6;
  await signIn(c);
  c.line();
  await pull(c);
  return 0;
};

const push = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay push");
  c.line();
  say(c, `3 changes in .env for ${c.bold(D.repo)}, ${D.env}:`);
  c.line();
  const mark = {
    changed: ["~", "amber"],
    added: ["+", "green"],
    removed: ["-", "red"],
  } as const;
  const owner = (o: string | null): string => o ?? c.paint("new", "amber");
  for (const ch of D.push) {
    const [m, tone] = mark[ch.kind];
    if (c.narrow)
      c.line(
        `${I}${c.paint(m, tone)} ${ch.name}\n${I}  ${c.paint(`${ch.kind}, ${ch.owner ?? "new"}`, "faint")}`,
      );
    else
      c.line(
        `${I}${c.paint(m, tone)} ${ch.name.padEnd(22)}${c.paint(ch.kind.padEnd(9), "muted")}${owner(ch.owner)}`,
      );
  }
  c.line();
  say(c, "Values stay hidden. Add --reveal to see them.", "muted");
  c.line();
  await menu(
    c,
    "FEATURE_NEW_CHECKOUT is new. Who gets its value?",
    [
      { label: "Team", detail: "teammates get it when they pull" },
      { label: "Only me", detail: "each teammate sets their own" },
    ],
    0,
  );
  c.line();
  const go = await yesNo(c, `Publish 3 changes to ${D.env}?`, "n", "y");
  if (!go) return 0;
  await step(
    c,
    1500,
    "Encrypting and signing",
    "Encrypted and signed on this device",
  );
  await step(
    c,
    900,
    "Publishing",
    `Published revision ${D.revision + 1} to ${D.env}`,
  );
  return 0;
};

const status = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay status");
  c.line();
  c.line(`${I}${c.bold(D.repo)} ${c.paint("·", "faint")} ${D.env}`);
  c.line();
  const rows: [string, string][] = [
    ["Server", D.origin],
    ["Account", `${D.user}, signed in with GitHub`],
    ["Device", `${D.device}, active`],
    [".env", `revision ${D.revision}, ${c.paint("one behind", "amber")}`],
  ];
  for (const [k, v] of rows)
    c.line(
      c.narrow
        ? `${I}${c.paint(k, "muted")}\n${I}  ${v}`
        : `${I}${c.paint(k.padEnd(9), "muted")}${v}`,
    );
  c.line();
  say(
    c,
    `jo published revision ${D.revision + 1} two hours ago. Run dotrelay pull to catch up.`,
    "muted",
  );
  return 0;
};

const failure = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay pull");
  c.line();
  await spin(
    c,
    1300,
    (tick) =>
      `${I}${c.paint(dots(tick), "green")} ${c.paint(`Pulling ${D.env}`, "muted")}`,
    `${I}${c.paint("!", "amber")}   ${c.paint(`Lost the connection to ${D.origin} while downloading revision ${D.revision + 1}.`, "amber")}`,
  );
  say(
    c,
    `    Nothing was written. .env is still at revision ${D.revision}.`,
    "muted",
  );
  c.line();
  await yesNo(c, "Try again?", "y", "y");
  await step(
    c,
    1200,
    `Pulling ${D.env}`,
    `Wrote .env: 3 values changed, now at revision ${D.revision + 1}`,
  );
  say(c, "    The old file is in .env.previous.", "muted");
  return 0;
};

const ci = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay pull --no-input");
  stop(
    c,
    `you're signed out of ${D.origin}`,
    "authentication_required",
    6,
    "dotrelay login",
  );
  await c.sleep(600);
  await c.shell("dotrelay pull --json");
  c.line(
    `{"ok":false,"code":"authentication_required","exitCode":6,"detail":"You're signed out of ${D.origin}.","next":"dotrelay login"}`,
  );
  return 6;
};

export const quiet: Record<SceneId, (c: Ctx) => Promise<number>> = {
  "first-run": firstRun,
  "signed-out": signedOut,
  push,
  status,
  failure,
  ci,
};
