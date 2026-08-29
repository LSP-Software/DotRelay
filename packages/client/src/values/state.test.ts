import { describe, expect, test } from "bun:test";
import {
  absentUserDefinedValue,
  classifyUserDefinedValue,
  emptyUserDefinedValue,
  isRevealPermitted,
} from "./state";

describe("user-defined value state", () => {
  test("keeps required absence distinct from an empty value", () => {
    expect(
      classifyUserDefinedValue({ required: true, ciphertext: null }),
    ).toEqual(absentUserDefinedValue());
    expect(
      classifyUserDefinedValue({
        required: true,
        ciphertext: new Uint8Array([1]),
        decryptedUtf8: "",
      }),
    ).toEqual(emptyUserDefinedValue());
  });

  test("forbids diagnostics reveal for every value state", () => {
    expect(isRevealPermitted(absentUserDefinedValue(), "diagnostics")).toBe(
      false,
    );
    expect(isRevealPermitted(emptyUserDefinedValue(), "diagnostics")).toBe(
      false,
    );
  });
});
