// PROTOTYPE. Direction C, "Plan": before doing anything, the command works
// out what's missing and shows it as a checklist. The whole run is that one
// list, redrawn in place, with prompts opening under the step that needs
// them. In CI the same list prints once, so the log shows exactly where it
// stopped.

import { D, type SceneId } from "./data";
import { type Ctx, input, type Live, pick, SPINNER, visible } from "./kit";

type State = "todo" | "active" | "done" | "attn" | "fail";
type Item = { label: string; value: string; state: State };

const mmss = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

const LABEL = 13;

const board = (c: Ctx, title: string, items: Item[]) => {
  const region: Live = c.live();
  let tick = 0;
  const glyph = (s: State): string =>
    s === "done"
      ? c.paint("✓", "green")
      : s === "active"
        ? c.paint(SPINNER[tick % SPINNER.length] ?? "", "green")
        : s === "attn"
          ? c.paint("!", "amber")
          : s === "fail"
            ? c.paint("✕", "red")
            : c.paint("○", "ghost");
  const valueTone = (s: State) =>
    (s === "todo"
      ? "faint"
      : s === "attn"
        ? "amber"
        : s === "fail"
          ? "red"
          : s === "active"
            ? "muted"
            : "fg") as const;
  const render = (
    detail?: { at: number; text: string },
    footer?: string,
  ): string => {
    const out = [`  ${c.bold(title)}`, ""];
    items.forEach((item, i) => {
      const label = c.paint(
        item.label.padEnd(LABEL),
        item.state === "todo" ? "faint" : "fg",
      );
      const value = c.paint(item.value, valueTone(item.state));
      if (c.narrow && visible(item.value) > c.width - LABEL - 7)
        out.push(`  ${glyph(item.state)}  ${label}`, `       ${value}`);
      else out.push(`  ${glyph(item.state)}  ${label}${value}`);
      if (detail && detail.at === i)
        for (const row of detail.text.split("\n")) out.push(`       ${row}`);
    });
    if (footer) out.push("", footer);
    return out.join("\n");
  };
  const set = (item: number, state: State, value?: string): void => {
    const target = items[item];
    if (!target) return;
    target.state = state;
    if (value !== undefined) target.value = value;
  };
  const run = async (
    item: number,
    ms: number,
    doing: string,
    doneValue: string,
    extra?: (elapsed: number) => string,
  ): Promise<void> => {
    set(item, "active", doing);
    for (let elapsed = 0; elapsed < ms; elapsed += 90) {
      tick += 1;
      const text = extra?.(elapsed);
      region.set(render(text ? { at: item, text } : undefined));
      await c.sleep(90);
    }
    set(item, "done", doneValue);
    region.set(render());
  };
  const choose = async (
    item: number,
    question: string,
    options: readonly { label: string; detail?: string }[],
    auto: number,
    doneValue: (i: number) => string,
  ): Promise<number> => {
    set(item, "attn", question);
    const w = Math.max(...options.map((o) => o.label.length)) + 2;
    const picked = await pick(
      c,
      options.length,
      auto,
      (cursor) =>
        render({
          at: item,
          text: [
            ...options.map(
              (o, i) =>
                `${i === cursor ? c.paint("›", "green") : " "} ${i === cursor ? c.paint(o.label, "green") : o.label}${o.detail && !c.narrow ? c.paint(`${" ".repeat(w - o.label.length)}${o.detail}`, "faint") : ""}`,
            ),
            c.paint("↑↓ enter", "ghost"),
          ].join("\n"),
        }),
      null,
      {},
      region,
    );
    set(item, "done", doneValue(picked));
    region.set(render());
    return picked;
  };
  const ask = async (
    item: number,
    question: string,
    note: string,
    options: readonly string[],
    auto: number,
    tone: State = "attn",
    start = 0,
  ): Promise<number> => {
    set(item, tone, question);
    return await pick(
      c,
      options.length,
      auto,
      (cursor) =>
        render({
          at: item,
          text: [
            ...(note ? [c.paint(note, "muted")] : []),
            options
              .map((o, i) =>
                i === cursor
                  ? c.paint(`[ ${o} ]`, "green")
                  : c.paint(`  ${o}  `, "faint"),
              )
              .join(" "),
          ].join("\n"),
        }),
      null,
      {},
      region,
      start,
    );
  };
  const type = async (
    item: number,
    question: string,
    note: string,
    auto: string,
  ): Promise<string> => {
    set(item, "attn", question);
    return await input(
      c,
      auto,
      (text) =>
        render({
          at: item,
          text: `${c.paint(note, "muted")}\n${c.paint("›", "green")} ${text}${c.paint("▏", "green")}`,
        }),
      region,
    );
  };
  const show = (footer?: string, detail?: { at: number; text: string }): void =>
    region.set(render(detail, footer));
  const finish = (footer: string): void =>
    region.keep(
      `${render(undefined, footer ? c.wrap(footer.trimStart(), 2) : undefined)}\n`,
    );
  return { run, choose, ask, type, show, finish, set, render };
};

const signInDetail =
  (c: Ctx) =>
  (elapsed: number): string =>
    [
      `${c.paint("open", "faint")}  ${c.paint(D.verifyUrl, "blue")}`,
      `${c.paint("code", "faint")}  ${c.bold(D.userCode)}   ${c.paint(`browser opened · ${mmss(elapsed)}`, "faint")}`,
    ].join("\n");

const pullDetail =
  (c: Ctx, total: number) =>
  (elapsed: number): string => {
    const share = Math.min(1, elapsed / 1400);
    const w = c.narrow ? 12 : 20;
    return `${c.paint("━".repeat(Math.round(share * w)), "green")}${c.paint("━".repeat(w - Math.round(share * w)), "ghost")} ${c.paint(`${Math.round(share * total)}/${total} decrypted`, "faint")}`;
  };

const start = async (
  c: Ctx,
  b: ReturnType<typeof board>,
  note: string,
): Promise<void> => {
  b.show(
    `  ${c.paint(note, "muted")}\n  ${c.paint("enter", "green")} ${c.paint("start   ", "faint")}${c.paint("q", "green")} ${c.paint("cancel", "faint")}`,
  );
  await c.key("enter");
};

const firstRun = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay pull");
  c.line();
  const b = board(c, `Pull ${D.repo} on this machine`, [
    { label: "Server", value: "not set up", state: "todo" },
    { label: "Sign in", value: "GitHub", state: "todo" },
    { label: "Device", value: D.device, state: "todo" },
    {
      label: "Account key",
      value: "from a device you already use",
      state: "todo",
    },
    { label: "Project", value: `${D.repo}, from remote origin`, state: "todo" },
    { label: "Environment", value: "choose one", state: "todo" },
    { label: "Pull", value: ".env", state: "todo" },
  ]);
  await start(
    c,
    b,
    "This machine isn't set up yet. 6 steps; two need your browser.",
  );
  await b.choose(
    0,
    "Which server?",
    [
      { label: D.origin, detail: "hosted by DotRelay" },
      { label: "Another server", detail: "type its address" },
    ],
    0,
    () => D.origin,
  );
  await b.run(0, 800, `checking ${D.origin}`, D.origin);
  await b.ask(
    0,
    `trust id ${D.serverId}?`,
    "Pins this id to this address. A different server here gets refused.",
    ["Trust", "Cancel"],
    0,
  );
  b.set(0, "done", `${D.origin} ${c.paint(`id ${D.serverId}`, "faint")}`);
  await b.run(
    1,
    3800,
    "waiting for GitHub",
    `${D.user} ${c.paint("(GitHub)", "faint")}`,
    (elapsed) =>
      `${signInDetail(c)(elapsed)}\n${c.paint("This proves who you are. It gives this machine no keys.", "faint")}`,
  );
  await b.run(2, 700, "adding", `${D.device} ${c.paint("added", "faint")}`);
  await b.choose(
    3,
    "how do you want to get it?",
    [
      { label: "From my browser", detail: `Devices, send key to ${D.device}` },
      { label: "Recovery code", detail: "13 groups of 4" },
    ],
    0,
    () => "from browser",
  );
  await b.type(
    3,
    "paste the transfer code",
    `In the web app, open Devices and send your key to ${D.device}.`,
    D.transferCode,
  );
  await b.run(
    3,
    1000,
    "opening the transfer",
    `received ${c.paint(`fingerprint ${D.fingerprint} matches`, "faint")}`,
  );
  await b.run(
    4,
    600,
    "looking it up",
    `${D.repo} ${c.paint("from remote origin", "faint")}`,
  );
  await b.choose(
    5,
    "which one?",
    D.envs,
    0,
    () => `${D.env} ${c.paint("saved for this folder", "faint")}`,
  );
  await b.run(
    6,
    1400,
    "pulling",
    `.env ${c.paint(`${D.pulled.total} values, ${D.pulled.team} Team, ${D.pulled.mine} Only me`, "faint")}`,
    pullDetail(c, D.pulled.total),
  );
  b.finish(
    `  ${c.paint("Done.", "green")} ${c.paint("Next time it's just dotrelay pull.", "muted")}`,
  );
  return 0;
};

const signedOut = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay pull");
  c.line();
  const b = board(c, `Pull ${D.repo} · ${D.env}`, [
    { label: "Server", value: D.origin, state: "done" },
    { label: "Sign in", value: "signed out, session expired", state: "attn" },
    { label: "Pull", value: ".env", state: "todo" },
  ]);
  const i = await b.ask(
    1,
    "signed out, session expired",
    "Sign in with GitHub, then the pull carries on.",
    ["Sign in", "Stop"],
    0,
  );
  if (i !== 0) return 6;
  await b.run(
    1,
    3800,
    "waiting for GitHub",
    `${D.user} ${c.paint("(GitHub)", "faint")}`,
    signInDetail(c),
  );
  await b.run(
    2,
    1400,
    "pulling",
    `.env ${c.paint(`${D.pulled.total} values, revision ${D.revision}`, "faint")}`,
    pullDetail(c, D.pulled.total),
  );
  b.finish(`  ${c.paint("Done.", "green")}`);
  return 0;
};

const push = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay push");
  c.line();
  const mark = {
    changed: ["~", "amber"],
    added: ["+", "green"],
    removed: ["-", "red"],
  } as const;
  const preview = D.push
    .map((ch) => {
      const [m, tone] = mark[ch.kind];
      return `${c.paint(m, tone)} ${ch.name.padEnd(c.narrow ? 0 : 22)}${c.narrow ? "\n  " : ""}${c.paint(`${ch.kind}, ${ch.owner ?? "Team"}`, "faint")}`;
    })
    .join("\n");
  const b = board(c, `Publish .env to ${D.repo} · ${D.env}`, [
    {
      label: "Changes",
      value: `3 since revision ${D.revision}`,
      state: "done",
    },
    { label: "New names", value: "FEATURE_NEW_CHECKOUT", state: "todo" },
    {
      label: "Review",
      value: "values hidden, --reveal shows them",
      state: "todo",
    },
    { label: "Publish", value: `revision ${D.revision + 1}`, state: "todo" },
  ]);
  await b.choose(
    1,
    "FEATURE_NEW_CHECKOUT: who gets it?",
    [
      { label: "Team", detail: "teammates get it when they pull" },
      { label: "Only me", detail: "each teammate sets their own" },
    ],
    0,
    () => `FEATURE_NEW_CHECKOUT ${c.paint("Team", "faint")}`,
  );
  const go = await b.ask(
    2,
    `publish these 3 to ${D.env}?`,
    preview,
    ["Publish", "Cancel"],
    0,
    "attn",
    1,
  );
  if (go !== 0) return 0;
  b.set(2, "done", `3 changes ${c.paint("+1 ~1 -1", "faint")}`);
  await b.run(3, 1200, "encrypting and signing", "", () =>
    c.paint("on this device; the server only sees ciphertext", "faint"),
  );
  await b.run(3, 900, "publishing", `revision ${D.revision + 1}`);
  b.finish(
    `  ${c.paint(`Published revision ${D.revision + 1}.`, "green")} ${c.paint("Teammates get it on their next pull.", "muted")}`,
  );
  return 0;
};

const status = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay status");
  c.line();
  const b = board(c, `${D.repo} · ${D.env}`, [
    { label: "Server", value: D.origin, state: "done" },
    { label: "Sign in", value: `${D.user} (GitHub)`, state: "done" },
    { label: "Device", value: `${D.device}, active`, state: "done" },
    { label: "Account key", value: "on this device", state: "done" },
    { label: ".env", value: `revision ${D.revision}, 1 behind`, state: "attn" },
  ]);
  const i = await b.ask(
    4,
    `revision ${D.revision}, 1 behind`,
    `jo published revision ${D.revision + 1} two hours ago. 3 values changed.`,
    ["Pull now", "Leave it"],
    0,
  );
  if (i !== 0) {
    b.finish("");
    return 0;
  }
  await b.run(
    4,
    1400,
    "pulling",
    `revision ${D.revision + 1}, up to date`,
    pullDetail(c, 3),
  );
  b.finish(`  ${c.paint("All ready.", "green")}`);
  return 0;
};

const failure = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay pull");
  c.line();
  const b = board(c, `Pull ${D.repo} · ${D.env}`, [
    { label: "Server", value: D.origin, state: "done" },
    { label: "Sign in", value: `${D.user} (GitHub)`, state: "done" },
    { label: "Pull", value: ".env", state: "todo" },
  ]);
  await b.run(2, 800, "pulling", "", pullDetail(c, D.pulled.total));
  b.set(2, "fail", `lost the connection to ${D.origin}`);
  const i = await b.ask(
    2,
    `lost the connection to ${D.origin}`,
    `Nothing was written. .env is still at revision ${D.revision}.`,
    ["Retry", "Stop"],
    0,
    "fail",
  );
  if (i !== 0) return 7;
  await b.run(
    2,
    1400,
    "pulling",
    `.env ${c.paint(`3 changed, revision ${D.revision + 1}, old copy in .env.previous`, "faint")}`,
    pullDetail(c, 3),
  );
  b.finish(`  ${c.paint("Done.", "green")}`);
  return 0;
};

const ci = async (c: Ctx): Promise<number> => {
  await c.shell("dotrelay pull --no-input");
  c.line(`pull stopped at step 2 of 3`);
  c.line(`  ${c.paint("✓", "green")} server     ${D.origin}`);
  c.line(
    `  ${c.paint("✕", "red")} sign in    signed out ${c.paint("(authentication_required)", "faint")}`,
  );
  c.line(`  ${c.paint("○", "ghost")} pull       ${D.env} → .env`);
  c.line(`exit 6. Next: dotrelay login`);
  await c.sleep(600);
  await c.shell("dotrelay pull --json");
  c.line(
    `{"ok":false,"code":"authentication_required","exitCode":6,"steps":[{"step":"server","ok":true},{"step":"sign-in","ok":false},{"step":"pull","ok":null}],"next":"dotrelay login"}`,
  );
  return 6;
};

export const plan: Record<SceneId, (c: Ctx) => Promise<number>> = {
  "first-run": firstRun,
  "signed-out": signedOut,
  push,
  status,
  failure,
  ci,
};
