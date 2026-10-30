import { loadProductionEnvironment } from "./runtime-config";
const environment = loadProductionEnvironment(process.env);
// Run the real entry module so its import.meta.main startup path is preserved.
const child = Bun.spawn([process.execPath, "apps/api/dist/index.js"], {
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
