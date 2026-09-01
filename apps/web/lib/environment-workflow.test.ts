import { expect, test } from "bun:test";
import {
  applyRollbackToVariables,
  changedLaneCount,
  createEnvironmentVariable,
  createRollbackPlan,
  prepareEncryptedPublication,
  protectedWorkflowBlockers,
  updateVariableValue,
  validateVariableDraft,
} from "./environment-workflow";

const sharedDraft = {
  name: "API_ORIGIN",
  description: "The public API origin.",
  ownership: "SHARED_VALUE" as const,
  value: "",
  required: true,
};

test("new Variables require a valid name and explicit ownership", () => {
  expect(
    validateVariableDraft({ ...sharedDraft, name: "not valid" }),
  ).toContain("letters");
  expect(validateVariableDraft({ ...sharedDraft, ownership: "" })).toContain(
    "Shared Value",
  );
  expect(validateVariableDraft(sharedDraft)).toBeNull();
});

test("creating a Variable establishes its definition and initial Value lane together", () => {
  const variable = createEnvironmentVariable(sharedDraft, "lane-1");

  expect(variable).toMatchObject({
    id: "lane-1",
    name: "API_ORIGIN",
    ownership: "SHARED_VALUE",
    value: "",
    changed: true,
  });
});

test("empty and absent User-defined Values remain distinct", () => {
  const variable = createEnvironmentVariable(
    {
      ...sharedDraft,
      name: "OPTIONAL_TOKEN",
      ownership: "USER_DEFINED_VALUE",
      value: "",
      required: false,
    },
    "lane-2",
  );

  expect(variable.value).toBeNull();
  expect(
    createEnvironmentVariable(
      { ...sharedDraft, name: "EMPTY_VALUE", value: "", required: true },
      "lane-3",
    ).value,
  ).toBe("");
  expect(updateVariableValue(variable, null).value).toBeNull();
});

test("changed lane count supports a publication review", () => {
  const unchanged = {
    ...createEnvironmentVariable(sharedDraft, "lane-1"),
    changed: false,
  };
  const changed = createEnvironmentVariable(
    { ...sharedDraft, name: "SIGNING_KEY" },
    "lane-2",
  );

  expect(changedLaneCount([unchanged, changed])).toBe(1);
});

test("publication preparation encrypts changed lanes and signs the mutation digest", async () => {
  const preparation = await prepareEncryptedPublication([
    createEnvironmentVariable(
      { ...sharedDraft, value: "local-only" },
      "lane-1",
    ),
  ]);

  expect(preparation).toMatchObject({
    encryptedLaneCount: 1,
    servicePlaintextBytes: 0,
    signatureBytes: 64,
  });
  expect(preparation.encryptedBytes).toBeGreaterThan(0);
});

test("rollback plans select lanes and never rewind the Environment head", () => {
  expect(createRollbackPlan("rev_0183", ["lane-1"])).toEqual({
    targetRevision: "rev_0183",
    selectedVariableIds: ["lane-1"],
    appendOnly: true,
  });
});

test("rollback applies only selected historical lanes while retaining the current head", () => {
  const variables = [
    createEnvironmentVariable({ ...sharedDraft, value: "current-a" }, "lane-1"),
    createEnvironmentVariable(
      { ...sharedDraft, name: "SECOND", value: "current-b" },
      "lane-2",
    ),
  ];
  const rolledBack = applyRollbackToVariables(
    variables,
    new Map([
      ["lane-1", "historical-a"],
      ["lane-2", "historical-b"],
    ]),
    ["lane-1"],
  );

  expect(rolledBack[0]?.value).toBe("historical-a");
  expect(rolledBack[1]?.value).toBe("current-b");
  expect(rolledBack[0]?.changed).toBe(true);
});

test("protected workflows report every unmet security gate", () => {
  expect(
    protectedWorkflowBlockers({
      profileTrusted: false,
      cryptoAvailable: false,
      deviceActive: false,
      grantsReady: false,
      resourceActive: false,
      epochCurrent: false,
      rotationRequired: true,
    }),
  ).toHaveLength(7);
  expect(
    protectedWorkflowBlockers({
      profileTrusted: true,
      cryptoAvailable: true,
      deviceActive: true,
      grantsReady: true,
      resourceActive: true,
      epochCurrent: true,
      rotationRequired: false,
    }),
  ).toEqual([]);
});
