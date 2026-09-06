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

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
