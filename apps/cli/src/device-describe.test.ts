import { expect, test } from "bun:test";
import { describeCliClient } from "./device-describe";

test("uses the machine hostname as the display name", () => {
  const info = describeCliClient({
    hostname: "CatchOS Main PC",
    platform: "linux",
  });
  expect(info).toEqual({
    displayName: "CatchOS Main PC",
    clientKind: "cli",
    osName: "Linux",
    clientSummary: "dotrelay-cli",
  });
});

test("maps platforms to human OS labels", () => {
  expect(
    describeCliClient({ hostname: "mbp", platform: "darwin" }).osName,
  ).toBe("macOS");
  expect(describeCliClient({ hostname: "pc", platform: "win32" }).osName).toBe(
    "Windows",
  );
  expect(describeCliClient({ hostname: "x", platform: "plan9" }).osName).toBe(
    "plan9",
  );
});

test("falls back when the hostname is empty or control-only", () => {
  expect(
    describeCliClient({ hostname: "\u0000\u001F   ", platform: "linux" })
      .displayName,
  ).toBe("dotrelay-cli");
});
