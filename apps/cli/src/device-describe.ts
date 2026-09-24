import { hostname } from "node:os";
import {
  type DeviceClientInfo,
  sanitizeDeviceClientSummary,
  sanitizeDeviceName,
  sanitizeDeviceOsName,
} from "@dotrelay/contracts";

// Describes this installation so the Server Profile can label it in the
// Devices table and recovery picker instead of showing a bare UUID. The CLI
// uses the machine hostname (CatchOS Main PC); browsers cannot read a
// hostname, so the web app derives a Chrome-on-Windows style label from the
// user agent instead (see apps/web/lib/device-describe.ts).

const platformLabel = (platform: NodeJS.Platform | string): string => {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    case "freebsd":
      return "FreeBSD";
    default:
      return String(platform);
  }
};

export const describeCliClient = (
  input: Readonly<{
    readonly hostname?: string;
    readonly platform?: string;
  }> = {},
): DeviceClientInfo => {
  const machine =
    sanitizeDeviceName(input.hostname ?? hostname()) ?? "dotrelay-cli";
  const os =
    sanitizeDeviceOsName(platformLabel(input.platform ?? process.platform)) ??
    "unknown";
  return Object.freeze({
    displayName: machine,
    clientKind: "cli",
    osName: os,
    clientSummary: sanitizeDeviceClientSummary("dotrelay-cli"),
  });
};
