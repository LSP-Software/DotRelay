import { expect, test } from "bun:test";
import { legal, subprocessors } from "./legal";

// The Privacy policy and Terms of service are rendered from these facts, so a
// placeholder must never ship.
test("legal facts contain no placeholders", () => {
  const values = [
    ...Object.values(legal),
    ...subprocessors.flatMap((provider) => Object.values(provider)),
  ];
  expect(values.filter((value) => value.includes("TODO"))).toEqual([]);
});
