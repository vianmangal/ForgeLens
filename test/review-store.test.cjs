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
const { ReviewStore, instructionLabel } = require("../dist/review/store.js");

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

const twoHunks = (store, runId, uri) => {
  const snap = store.captureSnapshot(doc(uri, text));
  const res = store.propose(runId, snap.snapshotId, { kind: "range", startLine: 1, endLine: 5,
    newText: "def f():\n    \"\"\"D.\"\"\"\n    a = 1\n    b = 2\n    c = 3\n    return a + 1\n" });
  assert.equal(res.ok, true);
  return res.hunkIds;
};

test("decideAll decides every pending hunk of a local run and nothing else", () => {
  const store = new ReviewStore();
  const decisions = [];
  store.onDidDecide(e => decisions.push([e.hunkId, e.decision, e.reason]));
  const run = store.createRun("inline", "t", "run-a");
  const other = store.createRun("inline", "t", "run-b");
  const [h1, h2] = twoHunks(store, run.runId, "file:///a.py");
  const [o1] = twoHunks(store, other.runId, "file:///b.py");
  store.decide(h1, "accepted");
  const decided = store.decideAll(run.runId, "rejected", "no");
  assert.deepEqual(decided, [h2]);
  assert.equal(store.getHunk(h1).status, "accepted");
  assert.equal(store.getHunk(h2).status, "rejected");
  assert.equal(store.getHunk(o1).status, "proposed");
  assert.deepEqual(decisions.at(-1), [h2, "rejected", "no"]);
  assert.deepEqual(store.decideAll(run.runId, "accepted"), []);
});

test("pendingHunkIds filters by status and skips queued hunks", () => {
  const store = new ReviewStore();
  const run = store.createRun("agent", "t", "run-c");
  const [h1, h2] = twoHunks(store, run.runId, "file:///c.py");
  assert.deepEqual(store.pendingHunkIds(run.runId, "approval_requested"), []);
  store.markApprovalRequested(h1, "call-1");
  assert.deepEqual(store.pendingHunkIds(run.runId, "approval_requested"), [h1]);
  assert.deepEqual(store.pendingHunkIds(run.runId), [h1, h2]);
  store.markQueued(h1);
  assert.deepEqual(store.pendingHunkIds(run.runId, "approval_requested"), []);
  assert.deepEqual(store.pendingHunkIds(run.runId), [h2]);
});

test("bulk choice is remembered while active and cleared on invalidate or apply", () => {
  const store = new ReviewStore();
  const run = store.createRun("agent", "t", "run-d");
  assert.equal(store.getBulkChoice(run.runId), undefined);
  assert.equal(store.setBulkChoice(run.runId, "accepted"), true);
  assert.equal(store.getBulkChoice(run.runId), "accepted");
  store.clearBulkChoice(run.runId);
  assert.equal(store.getBulkChoice(run.runId), undefined);

  store.setBulkChoice(run.runId, "rejected");
  store.invalidateRun(run.runId);
  assert.equal(store.getBulkChoice(run.runId), undefined);
  assert.equal(store.setBulkChoice(run.runId, "accepted"), false);

  const second = store.createRun("agent", "t", "run-e");
  const [h1] = twoHunks(store, second.runId, "file:///d.py");
  store.setBulkChoice(second.runId, "accepted");
  store.markApplied(second.runId, [h1]);
  assert.equal(store.getBulkChoice(second.runId), undefined);
  assert.equal(store.setBulkChoice("missing", "accepted"), false);
});

test("a later approval request can be decided with the remembered bulk choice", () => {
  const store = new ReviewStore();
  const run = store.createRun("agent", "t", "run-f");
  const [h1, h2] = twoHunks(store, run.runId, "file:///e.py");
  store.setBulkChoice(run.runId, "accepted");
  assert.equal(store.markApprovalRequested(h1, "call-1"), true);
  assert.equal(store.getBulkChoice(run.runId), "accepted");
  store.markQueued(h1);
  assert.equal(store.decide(h1, store.getBulkChoice(run.runId)), true);
  assert.equal(store.getHunk(h1).status, "accepted");
  assert.equal(store.getHunk(h2).status, "proposed");
});

test("visibleRuns hides inactive runs without hunks and latestActiveRun picks the newest active one", () => {
  const store = new ReviewStore();
  const empty = store.createRun("inline", "empty", "run-g");
  const full = store.createRun("inline", "full", "run-h");
  twoHunks(store, full.runId, "file:///f.py");
  const working = store.createRun("agent", "working", "run-i");
  assert.deepEqual(store.visibleRuns().map(r => r.runId), ["run-i", "run-h", "run-g"]);
  assert.equal(store.latestActiveRun().runId, "run-i");
  store.invalidateRun(empty.runId);
  store.invalidateRun(working.runId);
  assert.deepEqual(store.visibleRuns().map(r => r.runId), ["run-h"]);
  assert.equal(store.latestActiveRun().runId, "run-h");
  store.invalidateRun(full.runId);
  assert.equal(store.latestActiveRun(), undefined);
  assert.deepEqual(store.visibleRuns().map(r => r.runId), ["run-h"]);
});

test("runs keep their instruction and labels use the first 50 characters", () => {
  const store = new ReviewStore();
  const instruction = "  Rename   the helper\nto something much clearer and add a docstring explaining every parameter  ";
  const label = instructionLabel(instruction);
  assert.equal(label.length, 50);
  assert.equal(label, "Rename the helper to something much clearer and ad");
  assert.equal(instructionLabel("short"), "short");
  const run = store.createRun("inline", label, "run-j", instruction);
  assert.equal(store.getRun(run.runId).instruction, instruction);
  assert.equal(store.createRun("agent", "x", "run-k").instruction, undefined);
});

test("closeIfEmpty closes a finished run with no changes and leaves others alone", () => {
  const store = new ReviewStore();
  const empty = store.createRun("agent", "t", "run-l");
  const full = store.createRun("agent", "t", "run-m");
  twoHunks(store, full.runId, "file:///g.py");
  assert.equal(store.closeIfEmpty(full.runId), false);
  assert.equal(store.getRun(full.runId).active, true);
  assert.equal(store.closeIfEmpty(empty.runId), true);
  assert.equal(store.getRun(empty.runId).active, false);
  assert.equal(store.closeIfEmpty(empty.runId), false);
  assert.deepEqual(store.visibleRuns().map(r => r.runId), ["run-m"]);
  assert.equal(store.closeIfEmpty("missing"), false);
});

test("conflict flags only apply to active runs and are cleared when a run is applied or invalidated", () => {
  const store = new ReviewStore();
  const applied = store.createRun("agent", "t", "run-n");
  const dropped = store.createRun("agent", "t", "run-o");
  const [h1] = twoHunks(store, applied.runId, "file:///h.py");
  twoHunks(store, dropped.runId, "file:///h.py");
  store.refreshConflicts(doc("file:///h.py", "changed\n" + text, 2));
  assert.equal(store.isConflicted(applied.runId, Uri.parse("file:///h.py")), true);
  assert.equal(store.isConflicted(dropped.runId, Uri.parse("file:///h.py")), true);
  store.markApplied(applied.runId, [h1]);
  store.invalidateRun(dropped.runId);
  assert.equal(store.isConflicted(applied.runId, Uri.parse("file:///h.py")), false);
  assert.equal(store.isConflicted(dropped.runId, Uri.parse("file:///h.py")), false);
});

test("requestCancel reports whether it cancelled anything and markFinished sets the flag", () => {
  const store = new ReviewStore();
  const run = store.createRun("agent", "t", "run-p");
  assert.equal(store.getRun(run.runId).finished, false);
  store.markFinished(run.runId);
  assert.equal(store.getRun(run.runId).finished, true);
  assert.equal(store.requestCancel(run.runId), true);
  assert.equal(store.requestCancel(run.runId), false);
  assert.equal(store.requestCancel("missing"), false);
});
