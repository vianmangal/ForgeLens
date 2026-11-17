const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

class EventEmitter {
  constructor() { this.listeners = []; this.event = l => { this.listeners.push(l); return { dispose() {} }; }; }
  fire(e) { this.listeners.forEach(l => l(e)); }
  dispose() {}
}
class Uri {
  constructor(value) { this.value = value; }
  get path() { return this.value.replace("file://", ""); }
  toString() { return this.value; }
  static parse(v) { return new Uri(v); }
}
const fake = { EventEmitter, Uri, workspace: { asRelativePath: u => u.path.replace(/^\//, "") } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? fake : load.call(this, request, ...rest); };
const { ReviewStore } = require("../dist/review/store.js");

const doc = (uri, text, version = 1) => ({ uri: Uri.parse(uri), version, getText: () => text });
const text = "def f():\n    a = 1\n    b = 2\n    c = 3\n    return a\n";

test("harness-style flow: request, queue, decide, apply", () => {
  const store = new ReviewStore();
  const run = store.createRun("inline", "t", "run-1");
  const snap = store.captureSnapshot(doc("file:///x.py", text));
  const res = store.propose(run.runId, snap.snapshotId, { kind: "range", startLine: 1, endLine: 5,
    newText: "def f():\n    \"\"\"D.\"\"\"\n    a = 1\n    b = 2\n    c = 3\n    return a + 1\n" });
  assert.equal(res.ok, true);
  assert.equal(res.hunkIds.length, 2);
  const [first, second] = res.hunkIds;
  assert.equal(store.markApprovalRequested(first, "call-1"), true);
  store.markQueued(first);
  assert.equal(store.isQueued(first), true);
  assert.equal(store.decide(first, "accepted"), true);
  assert.equal(store.isQueued(first), false);
  assert.equal(store.decide(first, "rejected"), false);
  assert.equal(store.decide(second, "rejected"), true);
  store.markApplied(run.runId, [first]);
  assert.equal(store.getHunk(first).status, "applied");
  assert.equal(store.getRun(run.runId).active, false);
});

test("cancel invalidates pending hunks and blocks late proposals", () => {
  const store = new ReviewStore();
  let cancelled = "";
  store.onDidRequestCancel(id => { cancelled = id; });
  const run = store.createRun("agent", "t");
  const snap = store.captureSnapshot(doc("file:///y.py", text));
  const res = store.propose(run.runId, snap.snapshotId, { kind: "anchor", oldText: "b = 2", newText: "b = 22" });
  store.markQueued(res.hunkIds[0]);
  store.requestCancel(run.runId);
  assert.equal(cancelled, run.runId);
  assert.equal(store.getHunk(res.hunkIds[0]).status, "invalidated");
  assert.equal(store.isQueued(res.hunkIds[0]), false);
  assert.equal(store.decide(res.hunkIds[0], "accepted"), false);
  assert.equal(store.propose(run.runId, snap.snapshotId, { kind: "anchor", oldText: "c = 3", newText: "c = 4" }).ok, false);
});

test("a file edited during the run cannot receive new proposals", () => {
  const store = new ReviewStore();
  const run = store.createRun("agent", "t");
  const s1 = store.captureSnapshot(doc("file:///z.py", text, 1));
  assert.equal(store.propose(run.runId, s1.snapshotId, { kind: "anchor", oldText: "a = 1", newText: "a = 9" }).ok, true);
  const s2 = store.captureSnapshot(doc("file:///z.py", text, 2));
  assert.equal(store.propose(run.runId, s2.snapshotId, { kind: "anchor", oldText: "c = 3", newText: "c = 9" }).ok, true);
  const s3 = store.captureSnapshot(doc("file:///z.py", text.replace("b = 2", "b = 5"), 3));
  assert.equal(store.propose(run.runId, s3.snapshotId, { kind: "anchor", oldText: "return a", newText: "return b" }).ok, false);
});

test("serialize runs apply and cancel one after another", async () => {
  const store = new ReviewStore();
  const order = [];
  const a = store.serialize(async () => { await new Promise(r => setTimeout(r, 20)); order.push(1); });
  const b = store.serialize(async () => { order.push(2); });
  await Promise.all([a, b]);
  assert.deepEqual(order, [1, 2]);
});
