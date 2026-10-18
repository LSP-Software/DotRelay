import { describe, expect, test } from "bun:test";
import type { DecodedVariable } from "@dotrelay/client";
import { classifyPullValues } from "./pull-values";

const variable = (
  name: string,
  value: string | null,
  overrides: Partial<DecodedVariable> = {},
): DecodedVariable =>
  Object.freeze({
    id: name,
    name,
    description: "",
    ownership: "SHARED_VALUE",
    value,
    required: true,
    tombstone: false,
    ...overrides,
  });

describe("pull value classification", () => {
  test("omits optional absences and separates required gaps from unreadable values", () => {
    const groups = classifyPullValues(
      [
        variable("PRESENT", "value"),
        variable("OPTIONAL", null, { required: false }),
        variable("REQUIRED", null),
        variable("THEIRS", null, {
          ownership: "USER_DEFINED_VALUE",
          ownerUserId: "teammate",
        }),
      ],
      "actor",
    );
    expect(groups.present.map((entry) => entry.name)).toEqual(["PRESENT"]);
    expect(groups.optionalAbsent.map((entry) => entry.name)).toEqual([
      "OPTIONAL",
    ]);
    expect(groups.requiredMissing.map((entry) => entry.name)).toEqual([
      "REQUIRED",
    ]);
    expect(groups.unreadable.map((entry) => entry.name)).toEqual(["THEIRS"]);
  });
});
