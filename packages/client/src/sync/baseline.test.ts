import { describe, expect, test } from "bun:test";
import {
  applyBaselineResolution,
  reconcilePublicationBaseline,
  withResolvedConflicts,
} from "./baseline";
import type { DecodedVariable } from "./publication";

const variable = (
  id: string,
  name: string,
  value: string | null,
  overrides: Partial<DecodedVariable> = {},
): DecodedVariable =>
  Object.freeze({
    id,
    name,
    description: "",
    ownership: "SHARED_VALUE",
    value,
    required: true,
    tombstone: false,
    ...overrides,
  });

const reconciled = (result: ReturnType<typeof reconcilePublicationBaseline>) =>
  result.merged.filter((entry) => entry.hasDraftChange);

describe("publication baseline reconciliation", () => {
  test("keeps a remote addition beside an unrelated local edit", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a", "API_TOKEN", "one")],
      draft: [variable("a", "API_TOKEN", "two")],
      remote: [
        variable("a", "API_TOKEN", "one"),
        variable("b", "DATABASE_URL", "postgres"),
      ],
      remoteChangedVariableIds: new Set(["b"]),
    });
    expect(result.conflicts).toHaveLength(0);
    expect(reconciled(result).map((entry) => entry.name)).toEqual([
      "API_TOKEN",
    ]);
    expect(
      result.merged.find((entry) => entry.name === "DATABASE_URL"),
    ).toMatchObject({
      hasDraftChange: false,
      value: "postgres",
    });
  });

  test("keeps a remote edit to a variable the draft did not touch", () => {
    const result = reconcilePublicationBaseline({
      baseline: [
        variable("a", "API_TOKEN", "one"),
        variable("b", "DATABASE_URL", "old"),
      ],
      draft: [
        variable("a", "API_TOKEN", "two"),
        variable("b", "DATABASE_URL", "old"),
      ],
      remote: [
        variable("a", "API_TOKEN", "one"),
        variable("b", "DATABASE_URL", "new"),
      ],
      remoteChangedVariableIds: new Set(["b"]),
    });
    expect(result.conflicts).toHaveLength(0);
    expect(reconciled(result)).toEqual([
      expect.objectContaining({ name: "API_TOKEN", value: "two" }),
    ]);
  });

  test("does not treat identical edits as a conflict", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a", "API_TOKEN", "one")],
      draft: [variable("a", "API_TOKEN", "two")],
      remote: [variable("a", "API_TOKEN", "two")],
      remoteChangedVariableIds: new Set(["a"]),
    });
    expect(result.conflicts).toHaveLength(0);
    expect(reconciled(result)).toHaveLength(0);
  });

  test("asks for a choice when the same value diverges", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a", "API_TOKEN", "one")],
      draft: [variable("a", "API_TOKEN", "local")],
      remote: [variable("a", "API_TOKEN", "remote")],
      remoteChangedVariableIds: new Set(["a"]),
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      name: "API_TOKEN",
      kinds: ["value"],
      choices: ["local", "remote"],
      otherUserOwned: false,
    });
  });

  test("converges when both sides delete a variable", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a", "API_TOKEN", "one")],
      draft: [variable("a", "API_TOKEN", null, { tombstone: true })],
      remote: [variable("a", "API_TOKEN", null, { tombstone: true })],
      remoteChangedVariableIds: new Set(["a"]),
    });
    expect(result.conflicts).toHaveLength(0);
    expect(reconciled(result)).toHaveLength(0);
  });

  test("conflicts when a local deletion meets a remote edit", () => {
    const result = reconcilePublicationBaseline({
      baseline: [variable("a", "API_TOKEN", "one")],
      draft: [variable("a", "API_TOKEN", null, { tombstone: true })],
      remote: [variable("a", "API_TOKEN", "remote")],
      remoteChangedVariableIds: new Set(["a"]),
    });
    expect(result.conflicts[0]?.kinds).toContain("deletion");
    expect(result.conflicts[0]?.choices).toEqual(["local", "remote", "merge"]);
  });

  test("conflicts when both sides add the same name with different values", () => {
    const result = reconcilePublicationBaseline({
      baseline: [],
      draft: [variable("local", "API_TOKEN", "local")],
      remote: [variable("remote", "API_TOKEN", "remote")],
      remoteChangedVariableIds: new Set(["remote"]),
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      key: "name:API_TOKEN",
      choices: ["local", "remote"],
    });
  });

  test("converges when both sides add the same name and value", () => {
    const result = reconcilePublicationBaseline({
      baseline: [],
      draft: [variable("local", "API_TOKEN", "same")],
      remote: [variable("remote", "API_TOKEN", "same")],
      remoteChangedVariableIds: new Set(["remote"]),
    });
    expect(result.conflicts).toHaveLength(0);
    expect(reconciled(result)).toHaveLength(0);
    expect(result.merged[0]?.id).toBe("remote");
  });

  test("detects an unreadable remote edit without comparing values", () => {
    const base = variable("a", "API_TOKEN", null, { required: false });
    const untouched = reconcilePublicationBaseline({
      baseline: [base],
      draft: [base],
      remote: [base],
      remoteChangedVariableIds: new Set(["a"]),
    });
    expect(untouched.conflicts).toHaveLength(0);
    expect(reconciled(untouched)).toHaveLength(0);

    const overlap = reconcilePublicationBaseline({
      baseline: [base],
      draft: [variable("a", "API_TOKEN", "local", { required: false })],
      remote: [base],
      remoteChangedVariableIds: new Set(["a"]),
    });
    expect(overlap.conflicts[0]).toMatchObject({
      remoteUnreadable: true,
      choices: ["local", "remote"],
    });
  });

  test("offers only keep-remote for another user's value", () => {
    const result = reconcilePublicationBaseline({
      baseline: [
        variable("a", "USER_VALUE", null, {
          ownership: "USER_DEFINED_VALUE",
          ownerUserId: " teammate ".trim(),
        }),
      ],
      draft: [
        variable("a", "USER_VALUE", "mine", {
          ownership: "USER_DEFINED_VALUE",
          ownerUserId: "actor",
        }),
      ],
      remote: [
        variable("a", "USER_VALUE", null, {
          ownership: "USER_DEFINED_VALUE",
          ownerUserId: "teammate",
        }),
      ],
      remoteChangedVariableIds: new Set(["a"]),
      actorUserId: "actor",
    });
    expect(result.conflicts[0]).toMatchObject({
      otherUserOwned: true,
      choices: ["remote"],
    });
  });

  test("merge keeps the remote definition and the local value", () => {
    const conflict = reconcilePublicationBaseline({
      baseline: [variable("a", "API_TOKEN", "one", { description: "base" })],
      draft: [
        variable("a", "API_TOKEN", "local", {
          description: "local",
          tombstone: true,
        }),
      ],
      remote: [variable("a", "API_TOKEN", "remote", { description: "remote" })],
      remoteChangedVariableIds: new Set(["a"]),
    }).conflicts[0];
    if (!conflict) throw new Error("expected a conflict");
    const merged = applyBaselineResolution(conflict, "merge");
    expect(merged[0]).toMatchObject({
      description: "remote",
      value: "local",
      tombstone: true,
      hasDraftChange: true,
    });
  });

  test("keep-remote publishes no lane", () => {
    const reconciliation = reconcilePublicationBaseline({
      baseline: [variable("a", "API_TOKEN", "one")],
      draft: [variable("a", "API_TOKEN", "local")],
      remote: [variable("a", "API_TOKEN", "remote")],
      remoteChangedVariableIds: new Set(["a"]),
    });
    const conflict = reconciliation.conflicts[0];
    if (!conflict) throw new Error("expected a conflict");
    const resolved = withResolvedConflicts(
      reconciliation,
      new Map([[conflict.key, "remote"]]),
    );
    expect(resolved.filter((entry) => entry.hasDraftChange)).toHaveLength(0);
    expect(resolved[0]?.value).toBe("remote");
  });
});
