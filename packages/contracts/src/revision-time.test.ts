import { expect, test } from "bun:test";
import {
  chooseRevisionAuthoredAtMs,
  checkRevisionAuthoredAt,
  MAX_REVISION_CLOCK_SKEW_MS,
  PROBLEM_STATUS,
} from "./index";

test("a Revision may not precede its not-before floor or run past the clock skew", () => {
  const nowMs = 1_700_000_000_000;
  expect(
    checkRevisionAuthoredAt({ authoredAtMs: nowMs, notBeforeMs: nowMs, nowMs }),
  ).toBe("ok");
  expect(
    checkRevisionAuthoredAt({
      authoredAtMs: BigInt(nowMs - 1),
      notBeforeMs: BigInt(nowMs),
      nowMs,
    }),
  ).toBe("before_not_before");
  expect(
    checkRevisionAuthoredAt({
      authoredAtMs: nowMs + MAX_REVISION_CLOCK_SKEW_MS,
      nowMs,
    }),
  ).toBe("ok");
  expect(
    checkRevisionAuthoredAt({
      authoredAtMs: nowMs + MAX_REVISION_CLOCK_SKEW_MS + 1,
      notBeforeMs: null,
      nowMs,
    }),
  ).toBe("after_clock_skew");
  expect(MAX_REVISION_CLOCK_SKEW_MS).toBe(10 * 60 * 1_000);
});

test("a client raises a slow clock to the not-before floor", () => {
  expect(chooseRevisionAuthoredAtMs(1_000.7, 5_000)).toBe(5_000);
  expect(chooseRevisionAuthoredAtMs(9_000.2, 5_000)).toBe(9_000);
  expect(chooseRevisionAuthoredAtMs(9_000, undefined)).toBe(9_000);
  expect(chooseRevisionAuthoredAtMs(9_000, null)).toBe(9_000);
});

test("the new problem codes keep their stable statuses", () => {
  expect(PROBLEM_STATUS.authored_at_out_of_range).toBe(409);
  expect(PROBLEM_STATUS.pending_invitation_limit).toBe(409);
});
