import { describe, expect, test } from "bun:test";
import { isUndisclosedUserDefinedValue } from "./workflow-publication";

const variable = (
  overrides: Partial<Parameters<typeof isUndisclosedUserDefinedValue>[0]>,
): Parameters<typeof isUndisclosedUserDefinedValue>[0] => ({
  id: crypto.randomUUID(),
  name: "API_KEY",
  description: "",
  ownership: "USER_DEFINED_VALUE",
  value: null,
  required: true,
  tombstone: false,
  ...overrides,
});

describe("peer sharing republish scope", () => {
  test("leaves another User's undisclosed User-defined Value out", () => {
    expect(isUndisclosedUserDefinedValue(variable({}))).toBe(true);
  });

  test("keeps readable User-defined Values, Shared Values and tombstones", () => {
    expect(isUndisclosedUserDefinedValue(variable({ value: "mine" }))).toBe(
      false,
    );
    expect(
      isUndisclosedUserDefinedValue(
        variable({ ownership: "SHARED_VALUE", value: "shared" }),
      ),
    ).toBe(false);
    expect(isUndisclosedUserDefinedValue(variable({ tombstone: true }))).toBe(
      false,
    );
  });
});
