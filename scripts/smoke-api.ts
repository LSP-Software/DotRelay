import { access } from "node:fs/promises";
import { join } from "node:path";

const modulePath = join(
  import.meta.dir,
  "..",
  "apps",
  "api",
  "dist",
  "index.js",
);
await access(modulePath);
const { app } = (await import(modulePath)) as {
  app: { request: (url: string) => Promise<Response> };
};
const response = await app.request("http://localhost/health");
if (response.status !== 200)
  throw new Error(`API smoke test returned ${response.status}`);
console.log("✓ API production build responds to /health");
