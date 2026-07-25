import { describe, expect, test } from "bun:test";
import { app } from "./index";

describe("API foundation", () => {
  test("exposes a health endpoint", async () => {
    const response = await app.request("http://localhost/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
