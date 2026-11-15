import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Step = Readonly<{ run?: string; uses?: string; name?: string }>;
type Job = Readonly<{
  needs?: string | readonly string[];
  permissions?: Readonly<Record<string, string>>;
  environment?: string;
  steps?: readonly Step[];
}>;
type Workflow = Readonly<{
  permissions?: Readonly<Record<string, string>>;
  jobs: Readonly<Record<string, Job>>;
}>;

const root = join(import.meta.dir, "..");
const release = Bun.YAML.parse(
  await Bun.file(join(root, ".github/workflows/release.yml")).text(),
) as Workflow;

const runs = (job: Job | undefined): string =>
  (job?.steps ?? []).map((step) => step.run ?? "").join("\n");

const needs = (job: Job | undefined): readonly string[] =>
  job?.needs === undefined
    ? []
    : typeof job.needs === "string"
      ? [job.needs]
      : job.needs;

const privileged = (job: Job): boolean =>
  Object.entries(job.permissions ?? release.permissions ?? {}).some(
    ([, access]) => access === "write",
  ) || job.environment !== undefined;

describe("release workflow", () => {
  test("the verify job audits dependencies", () => {
    expect(runs(release.jobs.verify)).toContain("bun run security:audit");
  });

  test("no job that can publish or holds secrets runs the built CLI", () => {
    for (const [name, job] of Object.entries(release.jobs)) {
      if (!privileged(job)) continue;
      expect({ name, runs: runs(job) }).not.toMatchObject({
        runs: expect.stringMatching(/test-cli-package|cli-package-probes/),
      });
    }
  });

  test("an unprivileged job smoke-tests the packaged binaries before publish", () => {
    const smoke = release.jobs["smoke-cli-package"];
    expect(smoke).toBeDefined();
    expect(privileged(smoke as Job)).toBe(false);
    expect(runs(smoke)).toContain("bun scripts/test-cli-package.ts");
    expect(needs(smoke)).toContain("build-cli");
    expect(needs(release.jobs.publish)).toContain("smoke-cli-package");
  });
});
