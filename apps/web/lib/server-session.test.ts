import { expect, test } from "bun:test";
import { isSessionActive } from "./server-session";

const respond = (
  status: number,
  seen: { url?: string; cookie?: string | null } = {},
) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.cookie = new Headers(init?.headers).get("cookie");
    return new Response(null, { status });
  }) as unknown as typeof fetch;

test("only a 200 from the session relay counts as signed in", async () => {
  const seen: { url?: string; cookie?: string | null } = {};
  expect(
    await isSessionActive({
      apiOrigin: "https://api.test",
      cookie: "session=1",
      fetcher: respond(200, seen),
    }),
  ).toBe(true);
  expect(seen).toEqual({
    url: "https://api.test/api/v1/session",
    cookie: "session=1",
  });
  for (const status of [401, 404, 500])
    expect(
      await isSessionActive({
        apiOrigin: "https://api.test",
        cookie: "session=1",
        fetcher: respond(status),
      }),
    ).toBe(false);
});

test("no cookie, no origin, or an unreachable API reads as signed out", async () => {
  let called = false;
  const spy = (async () => {
    called = true;
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  expect(
    await isSessionActive({
      apiOrigin: "https://api.test",
      cookie: null,
      fetcher: spy,
    }),
  ).toBe(false);
  expect(
    await isSessionActive({
      apiOrigin: undefined,
      cookie: "s=1",
      fetcher: spy,
    }),
  ).toBe(false);
  expect(called).toBe(false);
  expect(
    await isSessionActive({
      apiOrigin: "https://api.test",
      cookie: "s=1",
      fetcher: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    }),
  ).toBe(false);
});
