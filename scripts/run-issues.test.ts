import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireLock,
  backoff,
  type Job,
  recordFailure,
  selectIssues,
} from "./run-issues-controller";
import { runProcess } from "./run-issues-process";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "dotrelay-runner-test-"));
  temporary.push(path);
  return path;
};
const job = (): Job => ({
  issue: 85,
  title: "Test",
  status: "pending",
  failures: 0,
  outages: 0,
  nextAttempt: 0,
});
const settings = { attempts: 2, delay: 10, outageDelay: 20, outageCap: 100 };

test("outages retain the issue and do not exhaust its implementation budget", () => {
  const item = job();
  for (let i = 0; i < 100; i++) recordFailure(item, true, 1000, settings);
  expect(item.status).toBe("pending");
  expect(item.failures).toBe(0);
  expect(item.nextAttempt).toBe(1100);
  expect(backoff(1, 20, 100)).toBe(20);
});

test("repeated implementation failures block just that issue", () => {
  const item = job();
  recordFailure(item, false, 0, settings);
  expect(item.status).toBe("pending");
  recordFailure(item, false, 10, settings);
  expect(item.status).toBe("blocked");
});

test("queue excludes assigned, blocked, unprioritized issues and PRs", () => {
  const base = {
    number: 1,
    title: "test",
    body: "Priority: P2",
    state: "open",
    labels: [{ name: "ready-for-agent" }],
    assignees: [],
    issue_dependencies_summary: { blocked_by: 0 },
  };
  expect(
    selectIssues([
      base,
      { ...base, number: 2, body: "Priority: P1" },
      { ...base, number: 3, assignees: [{ login: "someone" }] },
      { ...base, number: 4, issue_dependencies_summary: { blocked_by: 1 } },
      { ...base, number: 5, body: "unspecified" },
      { ...base, number: 6, pull_request: {} },
    ]).map((issue) => issue.number),
  ).toEqual([2, 1]);
});

test("lock rejects a second controller and can be reacquired after release", async () => {
  const path = join(await directory(), "lock");
  const release = await acquireLock(path);
  await expect(acquireLock(path)).rejects.toThrow("Another controller");
  await release();
  await (await acquireLock(path))();
});

test("a lock with no owner cannot be stolen during startup", async () => {
  const path = join(await directory(), "lock");
  await mkdir(path);
  await expect(acquireLock(path)).rejects.toThrow("has no owner");
});

test("deadline kills a detached descendant before it can keep writing", async () => {
  const path = await directory();
  const output = join(path, "late-write");
  const pidFile = join(path, "pid");
  const child = `setTimeout(async () => { await Bun.write(${JSON.stringify(output)}, 'orphan'); }, 3000);`;
  const parent = `import {spawn} from 'node:child_process';
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {detached:true, stdio:'ignore'});
    await Bun.write(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
  const result = await runProcess([process.execPath, "-e", parent], {
    timeout: 500,
  });
  expect(result.code).toBe(75);
  const pid = Number(await readFile(pidFile, "utf8"));
  // On Linux a killed child can briefly remain a zombie until init reaps it.
  const status = await runProcess(["ps", "-o", "stat=", "-p", String(pid)]);
  expect(status.code !== 0 || status.output.startsWith("Z")).toBe(true);
  expect(await Bun.file(output).exists()).toBe(false);
});

const mock = `#!/usr/bin/env bun
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const path = process.env.FAKE_STATE;
const data = JSON.parse(readFileSync(path, 'utf8'));
const save = () => writeFileSync(path, JSON.stringify(data));
const args = process.argv.slice(2);
const emit = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value));
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const number = Number(process.env.RUN_ISSUE_NUMBER || 85);
const issue = data.issues.find(item => item.number === number);
const meta = (item) => ({number: item.number + 100, url: 'https://github.com/LSP-Software/DotRelay/pull/' + (item.number + 100),
  headRefName: 'agent/issue-' + item.number, headRefOid: item.head, baseRefName: 'main', state: item.merged ? 'MERGED' : 'OPEN',
  isDraft:false, isCrossRepository:false, body:'Closes #' + item.number, mergeable:'MERGEABLE', mergeStateStatus:'CLEAN'});
if (process.argv[1].endsWith('opencode')) {
  if (args.includes('--help')) { emit('--auto'); process.exit(0); }
  issue.calls = (issue.calls || 0) + 1; save();
  if ((data.mode === 'outage' && number === 85 && issue.calls <= 3) || (data.mode === 'dirty' && issue.calls === 1)) {
    if (data.mode === 'dirty') writeFileSync('unfinished.txt', 'preserve me');
    emit({type:'error', error:{data:{message:'Cannot connect to API: Was there a typo in the url or port?', isRetryable:true}}});
    process.exit(1);
  }
  if (data.mode === 'error-event' && number === 85) {
    emit({type:'error', error:{message:'fatal session error'}});
    emit({type:'step_finish', part:{reason:'stop'}}); process.exit(0);
  }
  if (data.mode !== 'no-work' || number !== 85) {
    writeFileSync('implementation-' + number + '.txt', 'done');
    git('add', '.'); git('commit', '--allow-empty', '-m', 'Implement issue ' + number);
  }
  emit({type:'step_finish', part:{reason:'stop'}}); process.exit(0);
}
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'repo') { emit('LSP-Software/DotRelay'); process.exit(0); }
if (args[0] === 'api') {
  const endpoint = args.find(arg => arg.startsWith('repos/'));
  if (args.includes('user')) emit('runner');
  else if (endpoint.includes('/reviews')) emit(data.mode === 'human-review' ? [{user:{login:'reviewer'},state:'CHANGES_REQUESTED',submitted_at:'2026-09-11',commit_id:issue.head}] : []);
  else if (endpoint.includes('?')) emit(args.includes('--slurp') ? [data.issues.filter(item => item.state === 'open')] : data.issues.filter(item => item.state === 'open'));
  else emit(data.issues.find(item => item.number === Number(endpoint.split('/').at(-1))));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'edit') { issue.assignees = [{login:'runner'}]; save(); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'view') { emit(issue.state.toUpperCase()); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'list') {
  const head = args[args.indexOf('--head') + 1];
  const prs = data.issues.filter(item => item.pr && (args.includes('--head') ? head === 'agent/issue-' + item.number : !item.merged)).map(meta);
  emit(args.includes('--jq') ? (args.at(-1).includes('.url') ? (prs[0]?.url ?? '') : (prs[0] ?? '')) : prs); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  issue.creates = (issue.creates || 0) + 1;
  issue.pr = true; issue.head = git('rev-parse', 'HEAD'); save(); emit(meta(issue).url); process.exit(data.mode === 'lost-create' ? 1 : 0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  if (data.mode === 'changed-head') { issue.head = 'unexpected-head'; save(); }
  emit([{name:'check',bucket:data.mode === 'repair' && issue.calls < 2 ? 'fail' : 'pass'}]); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  if (data.mode === 'repair') { issue.head = execFileSync('git', ['--git-dir', process.env.FAKE_ORIGIN, 'rev-parse', 'refs/heads/agent/issue-' + number], {encoding:'utf8'}).trim(); save(); }
  const value = meta(issue);
  emit(args.includes('--jq') ? value[args.at(-1).slice(1)] : value); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  if (args.includes('--admin')) throw new Error('Unexpected administrator override');
  if (args[args.indexOf('--match-head-commit') + 1] !== issue.head) throw new Error('Unpinned merge');
  issue.merged = true; issue.state = 'closed'; data.merges.push(number); save(); process.exit(0);
}
throw new Error('Unexpected mock command: ' + args.join(' '));
`;

const fixture = async (mode: string, count = 2) => {
  const path = await directory();
  const root = join(path, "source");
  const bin = join(path, "bin");
  await mkdir(root);
  await mkdir(bin);
  const command = async (...args: string[]) => {
    const result = await runProcess(args, { cwd: root });
    if (result.code) throw new Error(result.output);
  };
  await command("git", "init", "-b", "main");
  await command("git", "config", "user.name", "Runner test");
  await command("git", "config", "user.email", "runner@example.test");
  await writeFile(join(root, "README.md"), "Fixture\n");
  await command("git", "add", ".");
  await command("git", "commit", "-m", "Initial");
  await command("git", "clone", "--bare", root, join(path, "origin.git"));
  await command("git", "remote", "add", "origin", join(path, "origin.git"));
  const data = {
    mode,
    merges: [],
    issues: Array.from({ length: count }, (_, i) => ({
      number: 85 + i,
      title: `Test ${i}`,
      body: "Priority: P1",
      html_url: `https://github.com/LSP-Software/DotRelay/issues/${85 + i}`,
      state: "open",
      labels: [{ name: "ready-for-agent" }],
      assignees: [],
      issue_dependencies_summary: { blocked_by: 0 },
    })),
  };
  const state = join(path, "github.json");
  await writeFile(state, JSON.stringify(data));
  for (const name of ["gh", "opencode"]) {
    await writeFile(join(bin, name), mock);
    await chmod(join(bin, name), 0o755);
  }
  const start = (args: string[] = []) =>
    runProcess(
      ["bash", resolve(import.meta.dir, "..", "run-issues.sh"), ...args],
      {
        cwd: root,
        timeout: 60_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          // The tests always start the controller entry point. Pin the worker
          // switch so a run from inside a live worker keeps its mode.
          RUN_ISSUES_WORKER: "0",
          FAKE_STATE: state,
          FAKE_ORIGIN: join(path, "origin.git"),
          GIT_AUTHOR_NAME: "Runner",
          GIT_AUTHOR_EMAIL: "runner@example.test",
          GIT_COMMITTER_NAME: "Runner",
          GIT_COMMITTER_EMAIL: "runner@example.test",
          MAX_SESSION_ATTEMPTS: "3",
          SESSION_RETRY_DELAY: "0",
          GH_RETRY_DELAY: "0",
          CHECK_SETTLE_SECONDS: "0",
          CHECK_POLL_INTERVAL: "1",
          MAX_ISSUE_ATTEMPTS: "1",
          OUTAGE_RETRY_DELAY: "1",
          OUTAGE_RETRY_CAP: "1",
          ISSUE_RETRY_DELAY: "1",
          MERGE_ADMIN: "0",
        },
      },
    );
  const read = async () => JSON.parse(await readFile(state, "utf8"));
  return { start, read, root, state };
};

test("full controller recovers on session four and drains both issues", async () => {
  const item = await fixture("outage");
  const result = await item.start();
  expect(result.output).toContain("Starting a fresh OpenCode session");
  expect(result.code).toBe(0);
  const state = await item.read();
  expect(state.issues[0].calls).toBe(4);
  expect(state.merges).toEqual([86, 85]);
  const rootStatus = await runProcess(["git", "status", "--porcelain"], {
    cwd: item.root,
  });
  expect(rootStatus.output).toBe("");
}, 60_000);

test("a failed issue does not prevent the next issue from merging", async () => {
  const item = await fixture("no-work");
  const result = await item.start();
  expect(result.code).toBe(2);
  expect((await item.read()).merges).toEqual([86]);
  const repeat = await item.start();
  expect(repeat.code).toBe(2);
  expect((await item.read()).issues[0].calls).toBe(1);
}, 60_000);

test("a later success event does not hide an earlier session error", async () => {
  const item = await fixture("error-event", 1);
  const result = await item.start();
  expect(result.code).toBe(2);
  expect(result.output).toContain("OpenCode emitted a session error");
  expect((await item.read()).merges).toEqual([]);
}, 60_000);

test("a fresh session preserves and commits interrupted edits", async () => {
  const item = await fixture("dirty", 1);
  const result = await item.start();
  expect(result.code).toBe(0);
  const file = join(
    item.root,
    ".git",
    "issue-runner",
    "issue-85",
    "checkout",
    "unfinished.txt",
  );
  const saved = await runProcess(
    ["git", "show", "agent/issue-85:unfinished.txt"],
    { cwd: resolve(file, "..") },
  );
  expect(saved.output).toBe("preserve me");
}, 60_000);

test("restart with --retry resumes a claimed issue before PR creation", async () => {
  const item = await fixture("no-work", 1);
  expect((await item.start()).code).toBe(2);
  const previous = await item.read();
  expect(previous.issues[0].assignees).toEqual([{ login: "runner" }]);
  previous.mode = "normal";
  await writeFile(item.state, JSON.stringify(previous));
  const restarted = await item.start(["--retry", "85"]);
  expect(restarted.code).toBe(0);
  expect((await item.read()).merges).toEqual([85]);
}, 60_000);

test("failed CI enters repair and checks the pushed repair commit", async () => {
  const item = await fixture("repair", 1);
  const result = await item.start();
  expect(result.output).toContain("Starting repair attempt 1");
  expect(result.code).toBe(0);
  expect((await item.read()).issues[0].calls).toBe(2);
  const checkpoint = JSON.parse(
    await readFile(
      join(item.root, ".git", "issue-runner", "issue-85", "worker.json"),
      "utf8",
    ),
  );
  expect(checkpoint.repairs).toBe(1);
}, 60_000);

test("an interrupted PR creation response does not create a duplicate", async () => {
  const item = await fixture("lost-create", 1);
  const result = await item.start();
  expect(result.code).toBe(0);
  expect((await item.read()).issues[0].creates).toBe(1);
}, 60_000);

test("human changes requested block merging without spending repair sessions", async () => {
  const item = await fixture("human-review", 1);
  const result = await item.start();
  expect(result.code).toBe(2);
  expect((await item.read()).merges).toEqual([]);
  expect((await item.read()).issues[0].calls).toBe(1);
  const previous = await item.read();
  previous.mode = "normal";
  await writeFile(item.state, JSON.stringify(previous));
  expect((await item.start(["--retry", "85"])).code).toBe(0);
  expect((await item.read()).issues[0].calls).toBe(1);
}, 60_000);

test("a changed PR head cannot use checks from the previous commit", async () => {
  const item = await fixture("changed-head", 1);
  const result = await item.start();
  expect(result.code).toBe(2);
  expect(result.output).toContain("PR head changed");
  expect((await item.read()).merges).toEqual([]);
}, 60_000);

test("a live legacy runner prevents starting a second controller", async () => {
  const item = await fixture("normal", 1);
  const lock = join(item.root, ".git", "opencode-runs", "controller.lock");
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "pid"), String(process.pid));
  const result = await item.start();
  expect(result.code).toBe(1);
  expect(result.output).toContain("previous runner is still running");
  expect((await item.read()).issues[0].assignees).toEqual([]);
}, 60_000);

test("stderr warnings do not corrupt captured JSON or truncate large responses", async () => {
  const text = "x".repeat(2_100_000);
  const result = await runProcess([
    process.execPath,
    "-e",
    "console.error('warning'); console.log(JSON.stringify('x'.repeat(2100000)));",
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toBe(text);
});
