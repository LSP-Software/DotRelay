import { expect, test } from "bun:test";
import { describeBrowserClient } from "./device-describe";

const chromeWindows =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const firefoxMac =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0";

const edgeIos =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/140.0 Mobile/15E148 Safari/605.1.15";

test("describes Chrome on Windows from the user agent", () => {
  expect(describeBrowserClient(chromeWindows)).toEqual({
    displayName: "Chrome on Windows 10/11",
    clientKind: "browser",
    osName: "Windows 10/11",
    clientSummary: "Chrome 140 on Windows 10/11",
  });
});

test("describes Firefox on macOS", () => {
  const info = describeBrowserClient(firefoxMac);
  expect(info.clientKind).toBe("browser");
  expect(info.displayName).toContain("Firefox");
  expect(info.osName).toBe("macOS");
});

test("describes Edge on iOS", () => {
  const info = describeBrowserClient(edgeIos);
  expect(info.displayName).toContain("Edge");
  expect(info.osName).toBe("iOS");
});

test("falls back for an empty user agent", () => {
  expect(describeBrowserClient("")).toEqual({
    displayName: "Browser",
    clientKind: "browser",
    osName: null,
    clientSummary: "Browser",
  });
});
