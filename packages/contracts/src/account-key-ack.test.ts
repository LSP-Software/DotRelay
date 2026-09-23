import { expect, test } from "bun:test";
import { accountKeyTransferAcknowledgementMessage } from "./account-key-ack";

test("acknowledgement message is domain-separated and includes the transfer id", () => {
  const transferId = new Uint8Array(16).fill(7);
  const message = accountKeyTransferAcknowledgementMessage(transferId);
  const prefix = new TextEncoder().encode(
    "dotrelay-account-key-transfer-ack-v1\0",
  );
  expect(message.slice(0, prefix.length)).toEqual(prefix);
  expect(message.slice(prefix.length)).toEqual(transferId);
});

test("acknowledgement message rejects a transfer id that is not 16 bytes", () => {
  expect(() =>
    accountKeyTransferAcknowledgementMessage(new Uint8Array(15)),
  ).toThrow(/16 bytes/);
});
