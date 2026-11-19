const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = listener => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) { [...this.listeners].forEach(listener => listener(value)); }
  dispose() { this.listeners.clear(); }
}

class Uri {
  constructor(filePath) { this.scheme = "file"; this.authority = ""; this.path = filePath; this.fsPath = filePath; }
  toString() { return "file://" + this.path; }
  static parse(value) { return new Uri(value.replace("file://", "")); }
  static joinPath(base, ...segments) { return new Uri(path.join(base.path, ...segments)); }
}

const settings = new Map();
const documents = new Map();
const vscode = {
  __esModule: true,
  EventEmitter,
  Uri,
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: {
    isTrusted: true,
    workspaceFolders: [],
    getConfiguration: () => ({ get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback }),
    asRelativePath: target => path.relative(vscode.workspace.workspaceFolders[0].uri.path, target.path),
    fs: {
      stat: async target => {
        const stat = await fs.lstat(target.path);
        return { size: stat.size, type: stat.isSymbolicLink() ? 64 : stat.isDirectory() ? 2 : 1 };
      }
    },
    openTextDocument: async target => {
      let document = documents.get(target.path);
      if (!document) {
        const text = await fs.readFile(target.path, "utf8");
        document = { uri: new Uri(target.path), version: 1, text };
        document.getText = () => document.text;
        Object.defineProperty(document, "lineCount", { get: () => document.text.split(/\r?\n/).length });
        documents.set(target.path, document);
      }
      return document;
    }
  }
};

const originalLoad = Module._load;
let tools, ReviewStore;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? vscode : originalLoad.call(this, name, ...args); };
  tools = require("../dist/mcp/tools.js");
  ({ ReviewStore } = require("../dist/review/store.js"));
} finally {
  Module._load = originalLoad;
}
const agent = require("../agent/forgelens.agent.json");

async function setup(t, files = { "a.py": "one\ntwo\nthree\nfour\nfive\n" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgelens-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  vscode.workspace.workspaceFolders = [{ uri: new Uri(root) }];
  documents.clear();
  settings.clear();
  const store = new ReviewStore();
  const registered = {};
  const state = { runId: "run-" + Math.random().toString(16).slice(2), active: true };
  store.createRun("agent", "t", state.runId);
  const context = {
    review: { store },
    currentRunId: () => state.runId,
    isRunActive: id => id === state.runId && state.active,
    registerProposed: () => true,
    onContextRows: () => {}
  };
  tools.registerForgeLensTools({ registerTool: (name, config, handler) => { registered[name] = { config, handler }; } }, context);
  t.after(() => tools.clearBudgetForRun(state.runId));
  const call = async (name, args, signal = new AbortController().signal) => {
    const response = await registered[name].handler(args, { signal });
    return { ...JSON.parse(response.content[0].text), isError: response.isError === true };
  };
  return { root, store, state, registered, call };
}

test("the registered tools match the manifest and describe their line and approval contracts", async t => {
  const { registered } = await setup(t);
  assert.deepEqual(Object.keys(registered), agent.mcpServers[0].enableTools);
  for (const { config } of Object.values(registered)) assert.ok(config.description.length > 40);
  assert.match(registered.read_range.config.description, /1-based and inclusive/);
  assert.match(registered.read_range.config.description, /snapshotId/);
  assert.match(registered.propose_edit.config.description, /endLine = startLine - 1/);
  assert.match(registered.approve_hunk.config.description, /exactly once per hunkId/);
  assert.match(registered.run_check.config.description, /only a baseline/);
});

test("read_range shortens ranges past the end of the file or over the line cap instead of failing", async t => {
  const lines = Array.from({ length: 400 }, (_, index) => "line " + (index + 1)).join("\n");
  const { call } = await setup(t, { "a.py": "one\ntwo\nthree", "long.py": lines });
  const pastEnd = await call("read_range", { path: "a.py", startLine: 2, endLine: 50 });
  assert.equal(pastEnd.status, "ok");
  assert.equal(pastEnd.endLine, 3);
  assert.equal(pastEnd.totalLines, 3);
  assert.equal(pastEnd.truncated, true);
  assert.equal(pastEnd.text, "2: two\n3: three");
  const long = await call("read_range", { path: "long.py", startLine: 1, endLine: 400 });
  assert.equal(long.status, "ok");
  assert.ok(long.endLine <= tools.MAX_READ_LINES);
  assert.equal(long.truncated, true);
  const beyond = await call("read_range", { path: "a.py", startLine: 9, endLine: 10 });
  assert.equal(beyond.isError, true);
  assert.match(beyond.message, /has 3 lines/);
  const reversed = await call("read_range", { path: "a.py", startLine: 3, endLine: 2 });
  assert.equal(reversed.isError, true);
});

test("propose_edit accepts only snapshots that read_range issued to the current run", async t => {
  const { store, call, root } = await setup(t);
  const foreign = store.captureSnapshot(await vscode.workspace.openTextDocument(new Uri(path.join(root, "a.py"))));
  const rejected = await call("propose_edit", { snapshotId: foreign.snapshotId, oldText: "two", newText: "TWO" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.message, /not returned by read_range in the current run/);
  const read = await call("read_range", { path: "a.py", startLine: 1, endLine: 3 });
  assert.equal(read.snapshotId, foreign.snapshotId);
  const accepted = await call("propose_edit", { snapshotId: read.snapshotId, oldText: "two", newText: "TWO" });
  assert.equal(accepted.status, "ok");
  assert.equal(accepted.hunkIds.length, 1);
});

test("propose_edit rejects a snapshot that no longer matches the live buffer and recovers after a re-read", async t => {
  const { call, root } = await setup(t);
  const first = await call("read_range", { path: "a.py", startLine: 1, endLine: 5 });
  const document = await vscode.workspace.openTextDocument(new Uri(path.join(root, "a.py")));
  document.text = document.text.replace("four", "FOUR by hand");
  document.version += 1;
  const stale = await call("propose_edit", { snapshotId: first.snapshotId, oldText: "two", newText: "TWO" });
  assert.equal(stale.isError, true);
  assert.match(stale.message, /changed after this snapshot was read/);
  const fresh = await call("read_range", { path: "a.py", startLine: 1, endLine: 5 });
  assert.notEqual(fresh.snapshotId, first.snapshotId);
  assert.equal((await call("propose_edit", { snapshotId: fresh.snapshotId, oldText: "two", newText: "TWO" })).status, "ok");
});

test("approve_hunk waits for the decision recorded after the gated call is allowed", async t => {
  const { store, call } = await setup(t);
  const read = await call("read_range", { path: "a.py", startLine: 1, endLine: 5 });
  const [hunkId] = (await call("propose_edit", { snapshotId: read.snapshotId, oldText: "two", newText: "TWO" })).hunkIds;
  store.markApprovalRequested(hunkId, "call-1");
  const pending = call("approve_hunk", { hunkId });
  await new Promise(resolve => setTimeout(resolve, 20));
  store.decide(hunkId, "accepted");
  const decided = await pending;
  assert.equal(decided.status, "accepted");
  assert.equal(decided.hunkId, hunkId);
});

test("approve_hunk reports a rejection as final and a cancellation as cancelled", async t => {
  const { store, state, call } = await setup(t);
  const read = await call("read_range", { path: "a.py", startLine: 1, endLine: 5 });
  const [first, second] = [
    ...(await call("propose_edit", { snapshotId: read.snapshotId, oldText: "two", newText: "TWO" })).hunkIds,
    ...(await call("propose_edit", { snapshotId: read.snapshotId, oldText: "four", newText: "FOUR" })).hunkIds
  ];
  store.markApprovalRequested(first, "call-1");
  store.decide(first, "rejected");
  const rejected = await call("approve_hunk", { hunkId: first });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.message, /final/);
  store.markApprovalRequested(second, "call-2");
  const waiting = call("approve_hunk", { hunkId: second });
  await new Promise(resolve => setTimeout(resolve, 20));
  state.active = false;
  await store.invalidateRun(state.runId);
  const cancelled = await waiting;
  assert.equal(cancelled.status, "cancelled");
});

test("approve_hunk stops waiting when the MCP request is aborted", async t => {
  const { call } = await setup(t);
  const read = await call("read_range", { path: "a.py", startLine: 1, endLine: 5 });
  const [hunkId] = (await call("propose_edit", { snapshotId: read.snapshotId, oldText: "two", newText: "TWO" })).hunkIds;
  const controller = new AbortController();
  const waiting = call("approve_hunk", { hunkId }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  const result = await waiting;
  assert.equal(result.status, "pending");
});

test("run_check reports the executed command and working directory", async t => {
  const { call, root } = await setup(t);
  settings.set("pythonPath", process.execPath);
  settings.set("checkProfiles", [{ id: "smoke", args: ["-e", "process.stdout.write('checked')"] }]);
  const outcome = await call("run_check", { checkId: "smoke" });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stdout, "checked");
  assert.deepEqual(outcome.command, [process.execPath, "-e", "process.stdout.write('checked')"]);
  assert.equal(outcome.cwd, root);
});

test("an invalid configured context budget falls back to the default instead of breaking retrieval", async t => {
  await setup(t);
  for (const value of [-5, "lots", Number.NaN, null]) {
    settings.set("contextBudget", value);
    const runId = "budget-" + String(value);
    assert.equal(tools.getBudgetForRun(runId).limitTokens, tools.DEFAULT_CONTEXT_BUDGET);
    tools.clearBudgetForRun(runId);
  }
  settings.set("contextBudget", 250);
  assert.equal(tools.getBudgetForRun("budget-valid").limitTokens, 250);
  tools.clearBudgetForRun("budget-valid");
});

test("cancelling the run stops a running check promptly and reports it as cancelled", async t => {
  const { call, state } = await setup(t);
  settings.set("pythonPath", process.execPath);
  settings.set("checkProfiles", [{ id: "slow", args: ["-e", "process.stdout.write('started'); setTimeout(() => process.stdout.write('finished'), 20000)"] }]);
  const started = Date.now();
  const running = call("run_check", { checkId: "slow" });
  setTimeout(() => { state.active = false; }, 200);
  const outcome = await running;
  assert.equal(outcome.status, "cancelled");
  assert.doesNotMatch(outcome.stdout, /finished/);
  assert.ok(Date.now() - started < 5000);
});
