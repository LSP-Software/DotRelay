import { afterAll, expect, test } from "bun:test";
import { signOutFromServerProfile } from "./session-actions";

const realFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

test("signOutFromServerProfile reports a successful sign-out", async () => {
  globalThis.fetch = (async () =>
    new Response(null, { status: 200 })) as unknown as typeof fetch;
  await expect(signOutFromServerProfile("http://localhost:3000")).resolves.toBe(
    true,
  );
});

test("signOutFromServerProfile treats a non-OK response as a failure", async () => {
  globalThis.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  await expect(signOutFromServerProfile("http://localhost:3000")).resolves.toBe(
    false,
  );
});

test("signOutFromServerProfile treats a rejected request as a failure", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await expect(signOutFromServerProfile("http://localhost:3000")).resolves.toBe(
    false,
  );
});
