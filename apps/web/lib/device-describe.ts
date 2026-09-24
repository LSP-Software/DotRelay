import {
  type DeviceClientInfo,
  sanitizeDeviceClientSummary,
  sanitizeDeviceName,
  sanitizeDeviceOsName,
} from "@dotrelay/contracts";

// A browser cannot read the machine hostname, so the auto name is derived
// from the user agent: "Chrome on Windows". Renameable from the Devices
// table; the server stops overwriting a renamed Device.

const detectBrowser = (
  userAgent: string,
): Readonly<{
  readonly name: string;
  readonly version: string | null;
}> | null => {
  const edge = userAgent.match(/Edg(?:e|A|iOS)?\/(\d+)/);
  if (edge) return { name: "Edge", version: edge[1] ?? null };
  const opera = userAgent.match(/OPR\/(\d+)/);
  if (opera) return { name: "Opera", version: opera[1] ?? null };
  const firefox = userAgent.match(/Firefox\/(\d+)/);
  if (firefox) return { name: "Firefox", version: firefox[1] ?? null };
  const chrome = userAgent.match(/Chrome\/(\d+)/);
  if (chrome) return { name: "Chrome", version: chrome[1] ?? null };
  const safari = userAgent.match(/Version\/(\d+).*Safari/);
  if (safari) return { name: "Safari", version: safari[1] ?? null };
  if (/Safari\//.test(userAgent)) return { name: "Safari", version: null };
  return null;
};

const detectOs = (userAgent: string): string | null => {
  if (/Windows NT 10/.test(userAgent)) return "Windows 10/11";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/iPhone|iPad/.test(userAgent)) return "iOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "macOS";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
};

export const describeBrowserClient = (userAgent: string): DeviceClientInfo => {
  const browser = detectBrowser(userAgent);
  const os = detectOs(userAgent);
  const browserLabel = browser?.name ?? null;
  const versioned = browser
    ? `${browser.name}${browser.version ? ` ${browser.version}` : ""}`
    : null;
  const display =
    sanitizeDeviceName(
      browserLabel ? `${browserLabel}${os ? ` on ${os}` : ""}` : "Browser",
    ) ?? "Browser";
  const summary =
    versioned && os
      ? `${versioned} on ${os}`
      : (versioned ?? (os ? `Browser on ${os}` : "Browser"));
  return Object.freeze({
    displayName: display,
    clientKind: "browser",
    osName: os ? sanitizeDeviceOsName(os) : null,
    clientSummary: sanitizeDeviceClientSummary(summary),
  });
};

export const describeThisBrowser = (): DeviceClientInfo =>
  describeBrowserClient(
    typeof navigator === "undefined" ? "" : navigator.userAgent,
  );
