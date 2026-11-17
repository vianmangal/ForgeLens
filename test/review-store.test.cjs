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

test("cancel invalidates pending hunks and blocks late proposals", async () => {
  const store = new ReviewStore();
  let cancelled = "";
  store.onDidRequestCancel(id => { cancelled = id; });
  const run = store.createRun("agent", "t");
  const snap = store.captureSnapshot(doc("file:///y.py", text));
  const res = store.propose(run.runId, snap.snapshotId, { kind: "anchor", oldText: "b = 2", newText: "b = 22" });
  store.markQueued(res.hunkIds[0]);
  await store.requestCancel(run.runId);
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

for (const decision of ["accepted", "rejected"]) {
  test(`${decision} bulk choice covers existing IDs with delayed approvals, never later proposals`, () => {
    const store = new ReviewStore();
    const run = store.createRun("agent", "bulk");
    const [first, delayed] = twoHunks(store, run.runId, "file:///bulk.py");
    store.markApprovalRequested(first, "first-call");
    assert.equal(store.setBulkChoice(run.runId, decision), true);
    assert.equal(store.getBulkChoice(run.runId, first), decision);
    store.markQueued(first);
    assert.equal(store.decide(first, store.getBulkChoice(run.runId, first)), true);
    assert.equal(store.getBulkChoice(run.runId, first), undefined);
    const later = anchorEdit(store, run.runId, "file:///bulk.py", "b = 7");
    assert.equal(later.ok, true);
    const unseen = later.hunkIds[0];
    store.markApprovalRequested(unseen, "later-call");
    assert.equal(store.getBulkChoice(run.runId, unseen), undefined);
    assert.equal(store.getHunk(unseen).status, "approval_requested");
    assert.equal(store.markApprovalRequested(delayed, "delayed-call"), true);
    assert.equal(store.decide(delayed, store.getBulkChoice(run.runId, delayed)), true);
    assert.equal(store.getHunk(delayed).status, decision);
    assert.equal(store.getHunk(unseen).status, "approval_requested");
  });
}

test("bulk choices clear on explicit clearing, invalidation and Apply", async () => {
  const store = new ReviewStore();
  const run = store.createRun("agent", "bulk");
  const [first] = twoHunks(store, run.runId, "file:///bulk-clear.py");
  store.setBulkChoice(run.runId, "accepted");
  store.clearBulkChoice(run.runId);
  assert.equal(store.getBulkChoice(run.runId, first), undefined);
  store.setBulkChoice(run.runId, "rejected");
  await store.invalidateRun(run.runId);
  assert.equal(store.getBulkChoice(run.runId, first), undefined);
  assert.equal(store.setBulkChoice(run.runId, "accepted"), false);
  const second = store.createRun("agent", "bulk");
  const [id] = twoHunks(store, second.runId, "file:///bulk-applied.py");
  store.setBulkChoice(second.runId, "accepted");
  store.markApplied(second.runId, [id]);
  assert.equal(store.getBulkChoice(second.runId, id), undefined);
  assert.equal(store.setBulkChoice("missing", "accepted"), false);
});

test("visibleRuns hides inactive runs without hunks and latestActiveRun picks the newest active one", async () => {
  const store = new ReviewStore();
  const empty = store.createRun("inline", "empty", "run-g");
  const full = store.createRun("inline", "full", "run-h");
  twoHunks(store, full.runId, "file:///f.py");
  const working = store.createRun("agent", "working", "run-i");
  assert.deepEqual(store.visibleRuns().map(r => r.runId), ["run-i", "run-h", "run-g"]);
  assert.equal(store.latestActiveRun().runId, "run-i");
  await store.invalidateRun(empty.runId);
  await store.invalidateRun(working.runId);
  assert.deepEqual(store.visibleRuns().map(r => r.runId), ["run-h"]);
  assert.equal(store.latestActiveRun().runId, "run-h");
  await store.invalidateRun(full.runId);
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

test("closeIfEmpty closes a finished run with no changes and leaves others alone", async () => {
  const store = new ReviewStore();
  const empty = store.createRun("agent", "t", "run-l");
  const full = store.createRun("agent", "t", "run-m");
  twoHunks(store, full.runId, "file:///g.py");
  assert.equal(await store.closeIfEmpty(full.runId), false);
  assert.equal(store.getRun(full.runId).active, true);
  assert.equal(await store.closeIfEmpty(empty.runId), true);
  assert.equal(store.getRun(empty.runId).active, false);
  assert.equal(await store.closeIfEmpty(empty.runId), false);
  assert.deepEqual(store.visibleRuns().map(r => r.runId), ["run-m"]);
  assert.equal(await store.closeIfEmpty("missing"), false);
});

test("conflict flags only apply to active runs and are cleared when a run is applied or invalidated", async () => {
  const store = new ReviewStore();
  const applied = store.createRun("agent", "t", "run-n");
  const dropped = store.createRun("agent", "t", "run-o");
  const [h1, h2] = twoHunks(store, applied.runId, "file:///h.py");
  store.decide(h1, "accepted");
  store.decide(h2, "rejected");
  twoHunks(store, dropped.runId, "file:///h.py");
  assert.equal(store.getRun(applied.runId).active, true);
  store.refreshConflicts(doc("file:///h.py", "changed\n" + text, 2));
  assert.equal(store.isConflicted(applied.runId, Uri.parse("file:///h.py")), true);
  assert.equal(store.isConflicted(dropped.runId, Uri.parse("file:///h.py")), true);
  store.markApplied(applied.runId, [h1]);
  await store.invalidateRun(dropped.runId);
  assert.equal(store.isConflicted(applied.runId, Uri.parse("file:///h.py")), false);
  assert.equal(store.isConflicted(dropped.runId, Uri.parse("file:///h.py")), false);
});

test("requestCancel reports whether it cancelled anything and markFinished sets the flag", async () => {
  const store = new ReviewStore();
  const run = store.createRun("agent", "t", "run-p");
  assert.equal(store.getRun(run.runId).finished, false);
  store.markFinished(run.runId);
  assert.equal(store.getRun(run.runId).finished, true);
  assert.equal((await store.requestCancel(run.runId)).cancelled, true);
  assert.equal((await store.requestCancel(run.runId)).cancelled, false);
  assert.equal((await store.requestCancel("missing")).cancelled, false);
});

test("a rejected hunk no longer blocks a new proposal on the same lines, but a pending or accepted one does", () => {
  const store = new ReviewStore();
  const run = store.createRun("agent", "t", "run-q");
  const snap = store.captureSnapshot(doc("file:///q.py", text));
  const edit = (newText) => store.propose(run.runId, snap.snapshotId, { kind: "anchor", oldText: "b = 2", newText });
  const first = edit("b = 20");
  assert.equal(first.ok, true);
  assert.equal(edit("b = 21").ok, false);
  store.decide(first.hunkIds[0], "accepted");
  assert.equal(edit("b = 22").ok, false);
  const other = store.createRun("agent", "t", "run-r");
  const first2 = store.propose(other.runId, snap.snapshotId, { kind: "anchor", oldText: "b = 2", newText: "b = 20" });
  store.decide(first2.hunkIds[0], "rejected");
  const retry = store.propose(other.runId, snap.snapshotId, { kind: "anchor", oldText: "b = 2", newText: "b = 23" });
  assert.equal(retry.ok, true);
  assert.equal(store.getHunk(first2.hunkIds[0]).status, "rejected");
  assert.equal(store.hunksOfRun(other.runId).length, 2);
});

const anchorEdit = (store, runId, uri, newText) => {
  const snap = store.captureSnapshot(doc(uri, text));
  return store.propose(runId, snap.snapshotId, { kind: "anchor", oldText: "b = 2", newText });
};

test("a new run proposing on a file cancels older active runs with undecided hunks there", async () => {
  const store = new ReviewStore();
  const cancelled = [];
  store.onDidRequestCancel(id => cancelled.push(id));
  const pending = store.createRun("inline", "t", "run-s1");
  anchorEdit(store, pending.runId, "file:///s.py", "b = 1");
  const decided = store.createRun("inline", "t", "run-s2");
  const d = anchorEdit(store, decided.runId, "file:///s.py", "b = 3");
  store.decide(d.hunkIds[0], "accepted");
  const elsewhere = store.createRun("inline", "t", "run-s3");
  anchorEdit(store, elsewhere.runId, "file:///other.py", "b = 4");
  const fresh = store.createRun("inline", "t", "run-s4");
  assert.equal(anchorEdit(store, fresh.runId, "file:///s.py", "b = 5").ok, true);
  await store.serialize(async () => {});
  assert.deepEqual(cancelled, ["run-s1"]);
  assert.equal(store.getRun(pending.runId).active, false);
  assert.equal(store.getRun(decided.runId).active, true);
  assert.equal(store.getRun(elsewhere.runId).active, true);
  assert.equal(store.getRun(fresh.runId).active, true);
  assert.equal(store.liveHunksForUri(Uri.parse("file:///s.py")).filter(h => h.status === "proposed").length, 1);
});

test("canApply needs an active finished run with an accepted hunk and no conflicted file", () => {
  const store = new ReviewStore();
  const run = store.createRun("agent", "t", "run-t");
  const [h1, h2] = twoHunks(store, run.runId, "file:///t.py");
  store.markFinished(run.runId);
  assert.equal(store.canApply(run.runId), false);
  store.decide(h1, "accepted");
  assert.equal(store.canApply(run.runId), true);
  store.refreshConflicts(doc("file:///t.py", "x\n" + text, 2));
  assert.equal(store.hasConflict(run.runId), true);
  assert.equal(store.canApply(run.runId), false);
  store.refreshConflicts(doc("file:///t.py", text, 3));
  assert.equal(store.canApply(run.runId), false);
  store.decide(h2, "rejected");
  store.markApplied(run.runId, [h1]);
  assert.equal(store.canApply(run.runId), false);
});

test("statusRun prefers the newest active run that still has pending or accepted hunks", async () => {
  const store = new ReviewStore();
  const older = store.createRun("inline", "t", "run-u1");
  twoHunks(store, older.runId, "file:///u1.py");
  const newer = store.createRun("inline", "t", "run-u2");
  const [n1, n2] = twoHunks(store, newer.runId, "file:///u2.py");
  assert.equal(store.statusRun().runId, "run-u2");
  store.decide(n1, "rejected");
  store.decide(n2, "rejected");
  assert.equal(store.statusRun().runId, "run-u1");
  await store.invalidateRun(older.runId);
  assert.equal(store.statusRun().runId, "run-u2");
  await store.invalidateRun(newer.runId);
  assert.equal(store.statusRun(), undefined);
});

test("clearInactive removes applied, cancelled and invalidated runs and keeps active ones", async () => {
  const store = new ReviewStore();
  const applied = store.createRun("inline", "t", "run-v1");
  const [a1] = twoHunks(store, applied.runId, "file:///v1.py");
  store.decide(a1, "accepted");
  store.markApplied(applied.runId, [a1]);
  const cancelled = store.createRun("inline", "t", "run-v2");
  twoHunks(store, cancelled.runId, "file:///v2.py");
  await store.requestCancel(cancelled.runId);
  const active = store.createRun("inline", "t", "run-v3");
  const [k1] = twoHunks(store, active.runId, "file:///v3.py");
  assert.equal(store.clearInactive(), 2);
  assert.deepEqual(store.visibleRuns().map(r => r.runId), ["run-v3"]);
  assert.equal(store.getHunk(a1), undefined);
  assert.equal(store.getHunk(k1).status, "proposed");
  assert.equal(store.clearInactive(), 0);
});


test("conflict indicators require both the snapshot version and hash", () => {
  const store = new ReviewStore();
  const run = store.createRun("agent", "versions");
  const uri = Uri.parse("file:///version.py");
  const [id] = twoHunks(store, run.runId, uri.toString());
  store.decide(id, "accepted");
  store.markFinished(run.runId);
  store.refreshConflicts(doc(uri.toString(), text, 1));
  assert.equal(store.canApply(run.runId), true);
  store.refreshConflicts(doc(uri.toString(), text, 2));
  assert.equal(store.isConflicted(run.runId, uri), true);
  assert.equal(store.canApply(run.runId), false);
  store.refreshConflicts(doc(uri.toString(), text + "changed", 1));
  assert.equal(store.isConflicted(run.runId, uri), true);
  store.refreshConflicts(doc(uri.toString(), text, 1));
  assert.equal(store.isConflicted(run.runId, uri), false);
});
