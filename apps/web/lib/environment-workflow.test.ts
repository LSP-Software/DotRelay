import { expect, test } from "bun:test";
import {
  applyRollbackToVariables,
  changedLaneCount,
  createEnvironmentVariable,
  createRollbackPlan,
  deleteEnvironmentVariable,
  prepareEncryptedPublication,
  protectedWorkflowBlockers,
  updateVariableValue,
  validateEnvironmentVariables,
  validateVariableDraft,
} from "./environment-workflow";

const sharedDraft = {
  name: "API_ORIGIN",
  description: "The public API origin.",
  ownership: "SHARED_VALUE" as const,
  value: "",
  valuePresent: true,
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

test("new Variables cannot duplicate a live Manifest name", () => {
  const existing = [createEnvironmentVariable(sharedDraft, "lane-1")];

  expect(validateVariableDraft(sharedDraft, existing)).toContain(
    "already exists",
  );
  expect(
    validateVariableDraft({ ...sharedDraft, name: "NEW_VARIABLE" }, existing),
  ).toBeNull();
});

test("creating a Variable establishes its definition and initial Value lane together", () => {
  const variable = createEnvironmentVariable(sharedDraft, "lane-1");

  expect(variable).toMatchObject({
    id: "lane-1",
    name: "API_ORIGIN",
    ownership: "SHARED_VALUE",
    value: "",
    hasDraftChange: true,
  });
});

test("empty and absent User-defined Values remain distinct", () => {
  const variable = createEnvironmentVariable(
    {
      ...sharedDraft,
      name: "OPTIONAL_TOKEN",
      ownership: "USER_DEFINED_VALUE",
      value: "",
      valuePresent: false,
      required: false,
    },
    "lane-2",
  );

  expect(variable.value).toBeNull();
  expect(
    createEnvironmentVariable(
      {
        ...sharedDraft,
        name: "EMPTY_VALUE",
        value: "",
        valuePresent: true,
        required: false,
      },
      "lane-3",
    ).value,
  ).toBe("");
  expect(updateVariableValue(variable, null).value).toBeNull();

  expect(() =>
    updateVariableValue(
      createEnvironmentVariable(sharedDraft, "required-lane"),
      null,
    ),
  ).toThrow("required Variable");
  expect(() =>
    updateVariableValue(variable, "x".repeat(1024 * 1024 + 1)),
  ).toThrow("1 MiB");
});

test("deleting a Variable leaves a changed tombstone without a Value", () => {
  const variable = createEnvironmentVariable(sharedDraft, "lane-1");
  const tombstone = deleteEnvironmentVariable(variable);

  expect(tombstone).toMatchObject({
    id: "lane-1",
    name: "API_ORIGIN",
    value: null,
    hasDraftChange: true,
    tombstone: true,
  });
  expect(() => updateVariableValue(tombstone, "forbidden")).toThrow(
    "tombstone",
  );
});

test("Manifest validation preserves unique live names and tombstones", () => {
  const variable = createEnvironmentVariable(sharedDraft, "lane-1");
  expect(validateEnvironmentVariables([variable])).toBeNull();
  expect(
    validateEnvironmentVariables([
      variable,
      createEnvironmentVariable({ ...sharedDraft, name: "SECOND" }, "lane-2"),
    ]),
  ).toBeNull();
  expect(
    validateEnvironmentVariables([variable, { ...variable, id: "lane-2" }]),
  ).toContain("duplicate live Variable name");
  expect(
    validateEnvironmentVariables([
      deleteEnvironmentVariable(variable),
      { ...variable, id: "lane-2", tombstone: true, value: "stale" },
    ]),
  ).toContain("tombstone cannot retain a Value");
});

test("changed lane count supports a publication review", () => {
  const unchanged = {
    ...createEnvironmentVariable(sharedDraft, "lane-1"),
    hasDraftChange: false,
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
  expect(preparation.laneCiphertextHashes).toHaveLength(1);
  expect(preparation.mutationSignature).toHaveLength(64);
  expect(preparation.encryptedBytes).toBeGreaterThan(0);
});

test("publication preparation rejects a Manifest that breaks required lanes", async () => {
  const requiredWithoutValue = {
    ...createEnvironmentVariable(sharedDraft, "lane-1"),
    value: null,
  };

  await expect(
    prepareEncryptedPublication([requiredWithoutValue]),
  ).rejects.toThrow("required Variable");
});

test("publication preparation signs tombstones without encrypting them as empty Values", async () => {
  const tombstone = deleteEnvironmentVariable(
    createEnvironmentVariable(sharedDraft, "lane-1"),
  );
  const preparation = await prepareEncryptedPublication([tombstone]);

  expect(preparation).toMatchObject({
    encryptedLaneCount: 0,
    tombstoneLaneCount: 1,
    servicePlaintextBytes: 0,
  });
  expect(preparation.tombstoneVariableIds).toEqual(["lane-1"]);
  expect(preparation.laneCiphertextHashes).toHaveLength(0);
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
  expect(rolledBack[0]?.hasDraftChange).toBe(true);
});

test("rollback refuses a selected lane without verified historical state", () => {
  const variable = createEnvironmentVariable(sharedDraft, "lane-1");

  expect(() =>
    applyRollbackToVariables(variable ? [variable] : [], new Map(), ["lane-1"]),
  ).toThrow("historical Value");
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
