import { describe, expect, test } from "bun:test";
import type { CborValue } from "./cbor";
import { ContractError } from "./errors";
import {
  LANE_FORMAT_CONTEXT_BOUND,
  LANE_FORMAT_LEGACY,
  laneAssociatedData,
} from "./lane";

const id = (fill: number) => new Uint8Array(16).fill(fill);

const lane = (
  format: number,
  overrides: ReadonlyArray<readonly [number, CborValue]> = [],
): Map<number, CborValue> =>
  new Map<number, CborValue>([
    [8, id(1)],
    [11, id(2)],
    [13, id(3)],
    [14, id(4)],
    [15, id(5)],
    [16, id(6)],
    [26, id(7)],
    [30, 1],
    [36, 4],
    [50, format],
    ...overrides,
  ]);

describe("lane associated data (ADR 0022)", () => {
  test("format 2 changes whenever any bound context field changes", () => {
    const base = laneAssociatedData(lane(LANE_FORMAT_CONTEXT_BOUND));
    for (const [field, value] of [
      [8, id(9)],
      [11, id(9)],
      [13, id(9)],
      [14, id(9)],
      [15, id(9)],
      [16, id(9)],
      [26, id(9)],
      [30, 2],
      [36, 3],
    ] as const)
      expect(
        laneAssociatedData(lane(LANE_FORMAT_CONTEXT_BOUND, [[field, value]])),
      ).not.toEqual(base);
  });

  test("format 1 keeps the original Variable, Revision and scope binding", () => {
    const legacy = laneAssociatedData(lane(LANE_FORMAT_LEGACY));
    // Another Team, Project and Environment leave a format-1 binding
    // unchanged; format 2 exists to close that gap.
    expect(
      laneAssociatedData(
        lane(LANE_FORMAT_LEGACY, [
          [11, id(9)],
          [13, id(9)],
          [14, id(9)],
        ]),
      ),
    ).toEqual(legacy);
    expect(legacy).not.toEqual(
      laneAssociatedData(lane(LANE_FORMAT_CONTEXT_BOUND)),
    );
  });

  test("rejects an unknown format or a format-2 lane missing its context", () => {
    expect(() => laneAssociatedData(lane(3))).toThrow(ContractError);
    const unbound = lane(LANE_FORMAT_CONTEXT_BOUND);
    unbound.delete(14);
    expect(() => laneAssociatedData(unbound)).toThrow(ContractError);
  });
});
