import { expect, test } from "bun:test";
import { GET } from "./route";

test("web health route returns an OK status", async () => {
  const response = GET();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
