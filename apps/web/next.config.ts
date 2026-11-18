import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

const loadRootEnv = () => {
  try {
    const text = readFileSync(resolve(process.cwd(), "../../.env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator);
      let value = trimmed.slice(separator + 1);
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Hosted builds and CI do not need the local root .env file.
  }
};

loadRootEnv();

// The workspace fixture trusts a checked-in revision signing key, so a
// production build or server must never enable it. An e2e harness that
// deliberately runs a production build opts in with a dedicated variable.
if (
  process.env.DOTRELAY_WORKSPACE_FIXTURE === "1" &&
  process.env.NODE_ENV === "production" &&
  process.env.DOTRELAY_E2E_ALLOW_PRODUCTION_FIXTURE !== "1"
) {
  throw new Error(
    "DOTRELAY_WORKSPACE_FIXTURE=1 is a development-only setting and cannot be used with NODE_ENV=production",
  );
}

// The browser shell can only read NEXT_PUBLIC_* values, so mirror the
// server-side fixture switch into a public twin for the client bundle.
if (
  process.env.DOTRELAY_WORKSPACE_FIXTURE === "1" &&
  process.env.NEXT_PUBLIC_DOTRELAY_WORKSPACE_FIXTURE === undefined
) {
  process.env.NEXT_PUBLIC_DOTRELAY_WORKSPACE_FIXTURE = "1";
}

// The browser bundle only sees NEXT_PUBLIC_* values. Release images set the
// public API and web origins at build time; a local `bun run dev` only has
// the server-side names in the root .env, so inline those for the browser.
// Without this the browser has no API origin and can never act as the Device
// it just set up. (Assigning to process.env here instead makes the dev
// server reload every page in a loop.)
const publicOrigin = (publicName: string, sources: readonly string[]) =>
  process.env[publicName] ??
  sources.map((name) => process.env[name]).find(Boolean);
const publicOrigins = Object.fromEntries(
  [
    [
      "NEXT_PUBLIC_DOTRELAY_API_ORIGIN",
      publicOrigin("NEXT_PUBLIC_DOTRELAY_API_ORIGIN", [
        "DOTRELAY_API_ORIGIN",
        "SERVER_PROFILE_ORIGIN",
      ]),
    ],
    [
      "NEXT_PUBLIC_WEB_ORIGIN",
      publicOrigin("NEXT_PUBLIC_WEB_ORIGIN", ["WEB_ORIGIN"]),
    ],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])),
);

const nextConfig: NextConfig = {
  output: "standalone",
  env: publicOrigins,
};

export default nextConfig;
