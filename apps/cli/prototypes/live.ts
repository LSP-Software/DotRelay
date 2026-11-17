// PROTOTYPE. Direction B, "Live": a rail down the left edge ties each run
// together, with spinners, progress bars, timings and inline toggles.

import { D, type SceneId } from "./data";
import { type Ctx, input, pick, SPINNER, spin, visible } from "./kit";

const bar = (c: Ctx) => c.paint("│", "ghost");

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const right = (c: Ctx, left: string, tail: string): string => {
  if (c.narrow) return left;
  const gap = c.width - 2 - visible(left) - visible(tail);
  return gap > 1 ? `${left}${" ".repeat(gap)}${tail}` : left;
};

const header = async (
  c: Ctx,
  command: string,
  context = `${D.repo} · ${D.env}`,
): Promise<void> => {
  await c.shell(`dotrelay ${command}`);
  c.line();
  c.line(
    right(
      c,
      `${c.paint("┌", "ghost")}  ${c.bold(`dotrelay ${command.split(" ")[0]}`)}`,
      c.paint(context, "faint"),
    ),
  );
  c.line(bar(c));
};

const rail = (c: Ctx, text = ""): void =>
  c.line(text.length === 0 ? bar(c) : `${bar(c)}  ${text}`);

const railWrap = (
  c: Ctx,
  text: string,
  tone: "muted" | "faint" | "fg" = "muted",
): void => {
  for (const row of c.wrap(text, 0, c.width - 3).split("\n"))
    rail(c, c.paint(row, tone));
};

const done = (c: Ctx, text: string, ms?: number): string =>
  right(
    c,
    `${c.paint("◇", "green")}  ${text}`,
    ms === undefined ? "" : c.paint(secs(ms), "faint"),
  );

const task = async (
  c: Ctx,
  ms: number,
  doing: string,
  finished: string,
): Promise<void> => {
  await spin(
    c,
    ms,
    (tick, elapsed) =>
      right(
        c,
        `${c.paint(SPINNER[tick % SPINNER.length] ?? "", "green")}  ${doing}`,
        c.paint(secs(elapsed), "faint"),
      ),
    `${done(c, finished, ms)}\n${bar(c)}`,
  );
};

const progress = async (
  c: Ctx,
  ms: number,
  label: string,
  total: number,
  finished: string,
  failAt?: number,
): Promise<boolean> => {
  const region = c.live();
  const width = c.narrow ? 12 : 24;
  const step = 90;
  for (let elapsed = 0, tick = 0; elapsed <= ms; elapsed += step, tick += 1) {
    const share = Math.min(1, elapsed / ms);
    if (failAt !== undefined && share >= failAt) {
      region.keep(
        `${c.paint("■", "red")}  ${label}  ${c.paint(`${"━".repeat(Math.round(width * share))}`, "red")}${c.paint("━".repeat(width - Math.round(width * share)), "ghost")}`,
      );
      return false;
    }
    const filled = Math.round(width * share);
    const count = Math.round(total * share);
    region.set(
      `${c.paint(SPINNER[tick % SPINNER.length] ?? "", "green")}  ${label}  ${c.paint("━".repeat(filled), "green")}${c.paint("━".repeat(width - filled), "ghost")}  ${c.paint(`${count}/${total}`, "faint")}`,
    );
    await c.sleep(step);
  }
  region.keep(`${done(c, finished, ms)}\n${bar(c)}`);
  return true;
};

/** A horizontal choice on one line: ● Yes   ○ No */
const toggle = async (
  c: Ctx,
  question: string,
  options: readonly string[],
  auto: number,
  start = 0,
): Promise<number> =>
  await pick(
    c,
    options.length,
    auto,
    (cursor) =>
      [
        `${c.paint("◆", "green")}  ${question}`,
        `${bar(c)}  ${options.map((o, i) => (i === cursor ? `${c.paint("●", "green")} ${o}` : c.paint(`○ ${o}`, "faint"))).join("   ")}`,
        `${bar(c)}  ${c.paint("←→ enter", "ghost")}`,
      ].join("\n"),
    (i) =>
      `${c.paint("◇", "green")}  ${question} ${c.paint(options[i] ?? "", "faint")}\n${bar(c)}`,
    {},
    c.live(),
    start,
  );

const list = async (
  c: Ctx,
  question: string,
  options: readonly { label: string; detail?: string }[],
  auto: number,
  note?: string,
): Promise<number> => {
  const w = Math.max(...options.map((o) => o.label.length)) + 2;
  return await pick(
    c,
    options.length,
    auto,
    (cursor) =>
      [
        `${c.paint("◆", "green")}  ${question}`,
        ...options.map((o, i) => {
          const dot =
            i === cursor ? c.paint("●", "green") : c.paint("○", "faint");
          const label = i === cursor ? o.label : c.paint(o.label, "muted");
          const detail =
            o.detail && !c.narrow
              ? c.paint(`${" ".repeat(w - o.label.length)}${o.detail}`, "faint")
              : "";
          return `${bar(c)}  ${dot} ${label}${detail}`;
        }),
        `${bar(c)}  ${c.paint("↑↓ enter", "ghost")}`,
      ].join("\n"),
    (i) =>
      `${c.paint("◇", "green")}  ${question} ${c.paint(options[i]?.label ?? "", "faint")}${note ? c.paint(`  · ${note}`, "ghost") : ""}\n${bar(c)}`,
  );
};

const signIn = async (c: Ctx): Promise<void> => {
  rail(c, `${c.paint("open", "faint")}  ${c.paint(D.verifyUrl, "blue")}`);
  rail(
    c,
    `${c.paint("code", "faint")}  ${c.bold(D.userCode)}  ${c.paint("browser opened", "ghost")}`,
  );
  rail(c);
  await task(
    c,
    3800,
    "Waiting for GitHub",
    `Signed in as ${c.bold(D.user)} ${c.paint("(GitHub)", "faint")}`,
  );
};

const end = (c: Ctx, text: string): void => {
  c.line(`${c.paint("└", "ghost")}  ${text}`);
  c.line();
};

const pulled = (c: Ctx): void =>
  end(
    c,
    `${c.paint(".env", "green")} ${c.paint("·", "faint")} ${D.pulled.total} values ${c.paint(`(${D.pulled.team} Team, ${D.pulled.mine} Only me)`, "faint")} ${c.paint("·", "faint")} revision ${D.revision}`,
  );

const firstRun = async (c: Ctx): Promise<number> => {
  await header(c, "pull", D.repo);
  c.line(
    `${c.paint("▲", "amber")}  ${c.paint("This machine isn't set up yet", "amber")}`,
  );
  railWrap(
    c,
    "Five quick steps, then your pull. Sign-in and the account key need you in a browser.",
  );
  rail(c);
  await list(
    c,
    "Server",
    [
      { label: D.origin, detail: "hosted by DotRelay" },
      { label: "Another server", detail: "type its address" },
    ],
    0,
  );
  await task(
    c,
    900,
    `Checking ${D.origin}`,
    `Server answered ${c.paint(`id ${D.serverId}`, "faint")}`,
  );
  await toggle(
    c,
    "Trust this server id at this address from now on?",
    ["Trust", "Cancel"],
    0,
  );
  railWrap(
    c,
    "GitHub sign-in proves who you are. It doesn't give this machine any keys.",
    "faint",
  );
  rail(c);
  await signIn(c);
  await task(c, 700, "Adding this device", `Device ${c.bold(D.device)} added`);
  c.line(
    `${c.paint("▲", "amber")}  ${c.paint("This device needs your account key", "amber")}`,
  );
  railWrap(
    c,
    `Send it from a browser or device you already use. In the web app: Devices, then send key to ${D.device}.`,
  );
  rail(c);
  await list(
    c,
    "Get the key",
    [
      { label: "From my browser", detail: "paste a transfer code" },
      { label: "Recovery code", detail: "13 groups of 4" },
    ],
    0,
  );
  const code = c.live();
  await input(
    c,
    D.transferCode,
    (text) =>
      `${c.paint("◆", "green")}  Transfer code\n${bar(c)}  ${c.paint("›", "green")} ${text}${c.paint("▏", "green")}`,
    code,
  );
  code.keep(
    `${c.paint("◇", "green")}  Transfer code ${c.paint(D.transferCode, "faint")}\n${bar(c)}`,
  );
  await task(
    c,
    1100,
    "Opening the transfer",
    `Account key received ${c.paint(`fingerprint ${D.fingerprint} matches`, "faint")}`,
  );
  c.line(
    `${done(c, `Project ${c.bold(D.repo)} ${c.paint("from remote origin", "faint")}`)}`,
  );
  rail(c);
  await list(c, "Environment", D.envs, 0, "saved for this folder");
  await progress(
    c,
    1600,
    "Decrypting",
    D.pulled.total,
    "Decrypted on this device",
  );
  pulled(c);
  return 0;
};

const signedOut = async (c: Ctx): Promise<number> => {
  await header(c, "pull");
  c.line(
    `${c.paint("▲", "amber")}  ${c.paint(`Signed out of ${D.origin}`, "amber")}`,
  );
  railWrap(
    c,
    "Your session expired. Sign in and the pull carries on from here.",
  );
  rail(c);
  const i = await toggle(c, "Sign in with GitHub?", ["Sign in", "Not now"], 0);
  if (i !== 0) return 6;
  await signIn(c);
  await progress(
    c,
    1600,
    "Decrypting",
    D.pulled.total,
    "Decrypted on this device",
  );
  pulled(c);
  return 0;
};

const push = async (c: Ctx): Promise<number> => {
  await header(c, "push");
  const mark = {
    changed: ["~", "amber"],
    added: ["+", "green"],
    removed: ["−", "red"],
  } as const;
  c.line(
    `${c.paint("◇", "green")}  3 changes since revision ${D.revision}  ${c.paint("+1", "green")} ${c.paint("~1", "amber")} ${c.paint("−1", "red")}`,
  );
  rail(c);
  const rows = (owner: number | null, cursor: boolean) =>
    D.push.map((ch) => {
      const [m, tone] = mark[ch.kind];
      let who: string;
      if (ch.owner) who = c.paint(ch.owner, "muted");
      else if (owner === null) who = c.paint("?", "amber");
      else if (!cursor)
        who = c.paint(owner === 0 ? "Team" : "Only me", "muted");
      else {
        const opts = ["Team", "Only me"].map((o, i) =>
          i === owner
            ? c.paint(`[${o}]`, cursor ? "green" : "fg")
            : c.paint(` ${o} `, "faint"),
        );
        who = opts.join("");
      }
      if (c.narrow)
        return `${bar(c)}  ${c.paint(m, tone)} ${ch.name}\n${bar(c)}    ${c.paint(ch.kind, "faint")} ${who}`;
      return `${bar(c)}  ${c.paint(m, tone)} ${ch.name.padEnd(22)} ${c.paint(ch.kind.padEnd(8), "faint")} ${who}`;
    });
  const owner = await pick(
    c,
    2,
    0,
    (cursor) =>
      [
        ...rows(cursor, true),
        bar(c),
        `${c.paint("◆", "amber")}  ${c.paint("FEATURE_NEW_CHECKOUT", "fg")} is new. Who gets its value?`,
        `${bar(c)}  ${c.paint(cursor === 0 ? "Team: teammates get it when they pull" : "Only me: each teammate sets their own", "faint")}`,
        `${bar(c)}  ${c.paint("←→ enter", "ghost")}`,
      ].join("\n"),
    (i) =>
      [
        ...rows(i, false),
        bar(c),
        `${c.paint("◇", "green")}  FEATURE_NEW_CHECKOUT ${c.paint(i === 0 ? "Team" : "Only me", "faint")}`,
        bar(c),
      ].join("\n"),
  );
  void owner;
  railWrap(c, "Values are hidden. Run with --reveal to see them.", "faint");
  rail(c);
  // Sending secrets: the cursor starts on Cancel.
  const go = await toggle(
    c,
    `Publish to ${D.env}?`,
    ["Publish", "Cancel"],
    0,
    1,
  );
  if (go !== 0) return 0;
  await task(c, 700, "Encrypting", "Encrypted on this device");
  await task(c, 500, "Signing", `Signed by ${D.device}`);
  await progress(c, 900, "Uploading", 3, "Uploaded");
  await task(c, 600, "Finalizing", "Finalized");
  end(
    c,
    `${c.paint(`Revision ${D.revision + 1}`, "green")} published to ${D.env}`,
  );
  return 0;
};

const status = async (c: Ctx): Promise<number> => {
  await header(c, "status");
  const rows: [string, string, string, "green" | "amber"][] = [
    ["server", D.origin, "trusted", "green"],
    ["account", `${D.user} (GitHub)`, "signed in", "green"],
    ["device", D.device, "active", "green"],
    [".env", `revision ${D.revision}`, "1 behind", "amber"],
  ];
  for (const [k, v, s, tone] of rows)
    if (c.narrow)
      rail(
        c,
        `${c.paint(k.padEnd(8), "faint")}${v}\n${bar(c)}  ${" ".repeat(8)}${c.paint(`● ${s}`, tone)}`,
      );
    else
      rail(
        c,
        `${c.paint(k.padEnd(9), "faint")}${v.padEnd(26)}${c.paint(`● ${s}`, tone)}`,
      );
  rail(c);
  c.line(
    `${c.paint("▲", "amber")}  ${c.paint(`jo published revision ${D.revision + 1}`, "amber")} ${c.paint("2h ago · 3 changed", "faint")}`,
  );
  rail(c);
  const i = await toggle(c, "Pull it now?", ["Pull", "Not now"], 0);
  if (i !== 0) return 0;
  await progress(c, 1200, "Decrypting", 3, "Decrypted on this device");
  end(
    c,
    `${c.paint(".env", "green")} up to date ${c.paint("·", "faint")} revision ${D.revision + 1}`,
  );
  return 0;
};

const failure = async (c: Ctx): Promise<number> => {
  await header(c, "pull");
  await progress(c, 2000, "Downloading", D.pulled.total, "", 0.55);
  rail(c);
  c.line(
    `${c.paint("▲", "amber")}  ${c.paint(`Lost the connection to ${D.origin}`, "amber")}`,
  );
  railWrap(c, `Nothing was written. .env is still at revision ${D.revision}.`);
  rail(c);
  const i = await toggle(c, "Try again?", ["Retry", "Stop"], 0);
  if (i !== 0) return 7;
  await progress(c, 1500, "Decrypting", 3, "Decrypted on this device");
  end(
    c,
    `${c.paint(".env", "green")} ${c.paint("·", "faint")} 3 changed ${c.paint("·", "faint")} revision ${D.revision + 1} ${c.paint("· old copy in .env.previous", "faint")}`,
  );
  return 0;
};

const ci = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay pull --no-input");
  c.line(`${c.paint("■", "red")} signed out of ${D.origin}`);
  c.line(
    `  ${c.paint("code", "faint")} authentication_required  ${c.paint("exit", "faint")} 6`,
  );
  c.line(`  ${c.paint("next", "faint")} dotrelay login`);
  await c.sleep(600);
  await c.shell("dotrelay pull --json");
  c.line(
    `{"ok":false,"code":"authentication_required","exitCode":6,"detail":"You're signed out of ${D.origin}.","next":"dotrelay login"}`,
  );
  return 6;
};

export const live: Record<SceneId, (c: Ctx) => Promise<number>> = {
  "first-run": firstRun,
  "signed-out": signedOut,
  push,
  status,
  failure,
  ci,
};
