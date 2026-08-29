import { describe, expect, test } from "bun:test";
import {
  acknowledgeHistoryTrustReset,
  createTrustedHeadStore,
  HistoryTrustResetRequiredError,
  type TrustedHead,
} from "./head";

const environmentId = new Uint8Array(16).fill(1);
const head = (revisionByte: number): TrustedHead =>
  Object.freeze({
    environmentId,
    revisionId: new Uint8Array(16).fill(revisionByte),
    revisionHash: new Uint8Array(48).fill(revisionByte),
  });

describe("trusted head continuity", () => {
  test("advances when the parent matches the stored head", () => {
    const store = createTrustedHeadStore();
    const first = head(1);
    const second = head(2);
    store.advance(first, null);
    store.advance(second, first);
    expect(store.get(environmentId)).toEqual(second);
  });

  test("refuses an implicit continuity reset", () => {
    const store = createTrustedHeadStore();
    store.advance(head(1), null);
    expect(() => store.advance(head(9), head(8))).toThrow(
      HistoryTrustResetRequiredError,
    );
  });

  test("allows an explicit history trust reset", () => {
    const store = createTrustedHeadStore();
    store.advance(head(1), null);
    const replacement = head(5);
    acknowledgeHistoryTrustReset(store, environmentId, replacement);
    expect(store.get(environmentId)).toEqual(replacement);
  });
});
