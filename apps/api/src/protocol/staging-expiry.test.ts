import { describe, expect, test } from "bun:test";
import { clampStagingExpiry, MINIMUM_STAGING_TTL_MS } from "./staging";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const DAY_SECONDS = 24 * 60 * 60;

describe("clampStagingExpiry", () => {
  test("defaults to the full TTL without a header", () => {
    expect(clampStagingExpiry(undefined, DAY_SECONDS, NOW).getTime()).toBe(
      NOW + DAY_SECONDS * 1000,
    );
  });

  test("defaults to the full TTL for an unparseable header", () => {
    expect(clampStagingExpiry("soon", DAY_SECONDS, NOW).getTime()).toBe(
      NOW + DAY_SECONDS * 1000,
    );
  });

  test("raises a near-immediate expiry to the minimum lifetime", () => {
    const oneSecond = new Date(NOW + 1000).toISOString();
    expect(clampStagingExpiry(oneSecond, DAY_SECONDS, NOW).getTime()).toBe(
      NOW + MINIMUM_STAGING_TTL_MS,
    );
  });

  test("raises a past expiry to the minimum lifetime", () => {
    const past = new Date(NOW - 60_000).toISOString();
    expect(clampStagingExpiry(past, DAY_SECONDS, NOW).getTime()).toBe(
      NOW + MINIMUM_STAGING_TTL_MS,
    );
  });

  test("keeps an expiry between the minimum and the TTL", () => {
    const hour = NOW + 60 * 60 * 1000;
    const header = new Date(hour).toISOString();
    expect(clampStagingExpiry(header, DAY_SECONDS, NOW).getTime()).toBe(hour);
  });

  test("caps an expiry at the configured TTL", () => {
    const week = new Date(NOW + 7 * DAY_SECONDS * 1000).toISOString();
    expect(clampStagingExpiry(week, DAY_SECONDS, NOW).getTime()).toBe(
      NOW + DAY_SECONDS * 1000,
    );
  });

  test("a TTL shorter than the minimum wins over the minimum", () => {
    const past = new Date(NOW - 60_000).toISOString();
    expect(clampStagingExpiry(past, 60, NOW).getTime()).toBe(NOW + 60_000);
  });
});
