import { describe, expect, test } from "bun:test";
import type { DecodedVariable, SyncPageWire } from "@dotrelay/client";
import { note } from "./components";
import { pullVariableNames } from "./pull-values";
import { rotationOwedNotice } from "./workflow-core";
import { renderRevisionHistory } from "./workflow-history";
import { conflictLines } from "./workflow-publication";
import { renderVariableList } from "./workflow-values";

// A Member can publish a Variable whose name holds terminal control
// sequences, and a server controls the strings it returns. None of them may
// reach the terminal as control sequences: they could rewrite earlier
// output, retitle the window, or write the clipboard.
const OSC_TITLE = "\u001b]0;owned\u0007";
const CLEAR = "\u001b[2J";
const hostile = `EVIL${OSC_TITLE}${CLEAR}\u009b31m`;

const expectInert = (text: string) => {
  expect(text).not.toContain(OSC_TITLE);
  expect(text).not.toContain(CLEAR);
  expect(text).not.toContain("\u0007");
  expect(text).not.toContain("\u009b");
};

const variable = (name: string): DecodedVariable =>
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000001",
    name,
    description: "",
    ownership: "SHARED_VALUE",
    value: "v",
    required: false,
    tombstone: false,
  });

describe("terminal output sanitizes untrusted text", () => {
  test("notes", () => {
    expectInert(note(hostile, "warn"));
    expect(note(hostile)).toContain("EVIL");
  });

  test("Variable names in pull messages", () => {
    expectInert(pullVariableNames([variable(hostile), variable("OK")]));
  });

  test("the list command", () => {
    const rendered = renderVariableList([
      {
        name: hostile,
        ownership: "shared",
        state: "set",
      },
    ]);
    expectInert(rendered);
    expect(rendered).toContain("EVIL");
  });

  test("the rotation-owed notice built from a server date", () => {
    expectInert(
      rotationOwedNotice({
        since: `${CLEAR}2026`,
        sinceEpoch: "1",
        membershipRemovals: 1,
        deviceRevocations: 0,
      }),
    );
  });

  test("history rows", () => {
    const revision = {
      id: `rev${OSC_TITLE}`,
      mutation: 2,
      projectEpoch: 1n,
      authoredAtMs: 0n,
      rollbackTargetId: `target${CLEAR}`,
    } as unknown as SyncPageWire["revisions"][number];
    expectInert(
      renderRevisionHistory("env", [
        {
          ordinal: 1,
          revision,
          current: true,
          changes: [
            {
              kind: "added",
              name: hostile,
              ownership: "shared",
              valueChanged: false,
            },
            {
              kind: "changed",
              name: hostile,
              ownership: "shared",
              valueChanged: true,
            },
          ],
        },
      ]),
    );
  });

  test("push conflict lines, revealed Values included", () => {
    const lines = conflictLines(
      {
        key: "k",
        name: hostile,
        kinds: ["value"],
        base: { value: hostile, tombstone: false },
        local: {
          value: hostile,
          tombstone: false,
          ownership: "SHARED_VALUE",
        },
        remote: {
          value: hostile,
          tombstone: false,
          ownership: "SHARED_VALUE",
        },
        remoteUnreadable: false,
        otherUserOwned: false,
        choices: ["local", "remote"],
      } as unknown as Parameters<typeof conflictLines>[0],
      true,
    );
    expectInert(lines.join("\n"));
  });
});
