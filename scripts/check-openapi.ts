import { resolve } from "node:path";
import { OPENAPI_DOCUMENT } from "@dotrelay/contracts";

const path = resolve(process.cwd(), "packages/contracts/openapi.json");
const actual = await Bun.file(path).json();
if (JSON.stringify(actual) !== JSON.stringify(OPENAPI_DOCUMENT)) {
  console.error(`✖ checked OpenAPI output is stale: ${path}`);
  process.exit(1);
}
console.log("✓ checked OpenAPI output matches @dotrelay/contracts");
