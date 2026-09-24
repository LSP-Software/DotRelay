import { describe, expect, test } from "bun:test";
import {
  DEVICE_NAME_MAX_LENGTH,
  deviceClientInfoPayload,
  parseDeviceClientInfo,
  sanitizeDeviceClientSummary,
  sanitizeDeviceName,
  sanitizeDeviceOsName,
} from "./device-client";
import { ContractError } from "./errors";

describe("sanitizeDeviceName", () => {
  test("trims, collapses whitespace, and caps length", () => {
    expect(sanitizeDeviceName("  CatchOS   Main PC  ")).toBe("CatchOS Main PC");
    expect(sanitizeDeviceName("x".repeat(DEVICE_NAME_MAX_LENGTH + 10))).toBe(
      "x".repeat(DEVICE_NAME_MAX_LENGTH),
    );
  });

  test("strips control characters and rejects empty results", () => {
    expect(sanitizeDeviceName("evil\u0000\u001Fname")).toBe("evil name");
    expect(sanitizeDeviceName("\u0000\u001F")).toBeNull();
    expect(sanitizeDeviceName("")).toBeNull();
  });

  test("caps OS and summary independently", () => {
    expect(sanitizeDeviceOsName("Windows 10/11")).toBe("Windows 10/11");
    expect(sanitizeDeviceClientSummary("dotrelay-cli")).toBe("dotrelay-cli");
    expect(sanitizeDeviceClientSummary("y".repeat(80))).toHaveLength(64);
  });
});

describe("parseDeviceClientInfo", () => {
  test("parses a complete client object", () => {
    expect(
      parseDeviceClientInfo({
        displayName: "CatchOS Main PC",
        clientKind: "cli",
        osName: "Linux",
        clientSummary: "dotrelay-cli",
      }),
    ).toEqual({
      displayName: "CatchOS Main PC",
      clientKind: "cli",
      osName: "Linux",
      clientSummary: "dotrelay-cli",
    });
  });

  test("accepts missing optional fields", () => {
    expect(
      parseDeviceClientInfo({
        displayName: "Chrome on Windows",
        clientKind: "browser",
      }),
    ).toEqual({
      displayName: "Chrome on Windows",
      clientKind: "browser",
      osName: null,
      clientSummary: null,
    });
  });

  test("returns null when the object is absent", () => {
    expect(parseDeviceClientInfo(undefined)).toBeNull();
    expect(parseDeviceClientInfo(null)).toBeNull();
  });

  test("throws ContractError on present-but-invalid fields", () => {
    expect(() => parseDeviceClientInfo("nope")).toThrow(ContractError);
    expect(() => parseDeviceClientInfo([])).toThrow(ContractError);
    expect(() =>
      parseDeviceClientInfo({ clientKind: "other", displayName: "x" }),
    ).toThrow(ContractError);
    expect(() => parseDeviceClientInfo({ clientKind: "cli" })).toThrow(
      ContractError,
    );
    expect(() =>
      parseDeviceClientInfo({ displayName: 1, clientKind: "cli" }),
    ).toThrow(ContractError);
  });
});

test("deviceClientInfoPayload omits null optional fields", () => {
  expect(
    deviceClientInfoPayload({
      displayName: "dotrelay-cli",
      clientKind: "cli",
      osName: null,
      clientSummary: null,
    }),
  ).toEqual({ displayName: "dotrelay-cli", clientKind: "cli" });
});
