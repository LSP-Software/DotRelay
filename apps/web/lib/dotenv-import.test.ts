import { describe, expect, test } from "bun:test";
import { applyDotenvImport, planDotenvImport } from "./dotenv-import";
import type { EnvironmentVariable } from "./environment-workflow";

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const variable = (
  name: string,
  value: string | null,
  fields: Partial<EnvironmentVariable> = {},
): EnvironmentVariable => ({
  id: `id-${name}`,
  name,
  description: "",
  ownership: "SHARED_VALUE",
  value,
  required: false,
  hasDraftChange: false,
  originalProviderUserId: ME,
  ...fields,
});

const owner = { role: "OWNER" as const, actorUserId: ME };
const member = { role: "MEMBER" as const, actorUserId: ME };

describe("planDotenvImport", () => {
  const current = [
    variable("SAME", "1"),
    variable("CHANGED", "old"),
    variable("THEIRS", "x", { originalProviderUserId: OTHER }),
    variable("GONE", null, { tombstone: true, hasDraftChange: true }),
  ];
  const entries = [
    { name: "SAME", value: "1" },
    { name: "CHANGED", value: "new" },
    { name: "THEIRS", value: "y" },
    { name: "GONE", value: "back" },
    { name: "NEW_ONE", value: "fresh" },
  ];

  test("an owner adds new names and updates changed values", () => {
    expect(planDotenvImport(entries, current, owner)).toEqual([
      { kind: "unchanged", name: "SAME" },
      {
        kind: "update",
        name: "CHANGED",
        value: "new",
        variableId: "id-CHANGED",
      },
      { kind: "update", name: "THEIRS", value: "y", variableId: "id-THEIRS" },
      {
        kind: "blocked",
        name: "GONE",
        reason:
          "It's marked for deletion in your draft. Undo the delete first.",
      },
      { kind: "add", name: "NEW_ONE", value: "fresh" },
    ]);
  });

  test("a member can only update values they provided", () => {
    const plan = planDotenvImport(entries, current, member);
    expect(plan.find((action) => action.name === "CHANGED")?.kind).toBe(
      "update",
    );
    expect(plan.find((action) => action.name === "THEIRS")).toMatchObject({
      kind: "blocked",
    });
    expect(plan.find((action) => action.name === "NEW_ONE")).toEqual({
      kind: "blocked",
      name: "NEW_ONE",
      reason: "Only owners and admins can add variables.",
    });
  });
});

describe("applyDotenvImport", () => {
  test("stages updates and additions as draft changes", () => {
    const current = [variable("CHANGED", "old"), variable("KEEP", "k")];
    const plan = planDotenvImport(
      [
        { name: "CHANGED", value: "new" },
        { name: "ADDED", value: "a" },
      ],
      current,
      owner,
    );
    const next = applyDotenvImport(plan, current, {
      ownership: "USER_DEFINED_VALUE",
      actorUserId: ME,
      baselineFor: (id) => current.find((entry) => entry.id === id),
      nextId: () => "new-id",
    });
    expect(
      next.map((entry) => [entry.name, entry.value, entry.hasDraftChange]),
    ).toEqual([
      ["CHANGED", "new", true],
      ["KEEP", "k", false],
      ["ADDED", "a", true],
    ]);
    expect(next[2]).toMatchObject({
      id: "new-id",
      ownership: "USER_DEFINED_VALUE",
      ownerUserId: ME,
      required: true,
    });
  });

  test("an update back to the published value is not a draft change", () => {
    const published = variable("A", "orig");
    const drafted = { ...published, value: "edited", hasDraftChange: true };
    const plan = planDotenvImport(
      [{ name: "A", value: "orig" }],
      [drafted],
      owner,
    );
    const [next] = applyDotenvImport(plan, [drafted], {
      ownership: "SHARED_VALUE",
      actorUserId: ME,
      baselineFor: () => published,
      nextId: () => "unused",
    });
    expect(next?.value).toBe("orig");
    expect(next?.hasDraftChange).toBe(false);
  });
});
