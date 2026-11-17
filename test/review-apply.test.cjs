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
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class WorkspaceEdit {
  constructor() { this.edits = []; }
  replace(uri, range, text) { this.edits.push({ uri, range, text }); }
}

const docs = new Map();
const applied = [];
let beforeOpen = async () => {};

function makeDoc(uri, text) {
  const doc = {
    uri: Uri.parse(uri), version: 1, text,
    getText() { return this.text; },
    offsetAt(p) {
      let line = 0, i = 0;
      while (line < p.line) { i = this.text.indexOf("\n", i) + 1; line++; }
      return i + p.character;
    },
    positionAt(offset) {
      const before = this.text.slice(0, offset);
      const line = before.split("\n").length - 1;
      return new Position(line, offset - (before.lastIndexOf("\n") + 1));
    }
  };
  docs.set(uri, doc);
  return doc;
}

const fake = {
  EventEmitter, Uri, Position, Range, WorkspaceEdit,
  window: { showWarningMessage: async () => "Apply accepted only" },
  workspace: {
    asRelativePath: u => u.path.replace(/^\//, ""),
    openTextDocument: async uri => { await beforeOpen(uri.toString()); return docs.get(uri.toString()); },
    applyEdit: async edit => {
      applied.push(edit);
      const byUri = new Map();
      for (const e of edit.edits) {
        const doc = docs.get(e.uri.toString());
        if (!byUri.has(doc)) byUri.set(doc, []);
        byUri.get(doc).push({ start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), text: e.text });
      }
      for (const [doc, list] of byUri) {
        list.sort((a, b) => b.start - a.start);
        for (const e of list) doc.text = doc.text.slice(0, e.start) + e.text + doc.text.slice(e.end);
        doc.version++;
      }
      return true;
    }
  }
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? fake : load.call(this, request, ...rest); };
const { ReviewStore } = require("../dist/review/store.js");
const { Applier } = require("../dist/review/apply.js");
const { fakeEditText } = require("../dist/review/index.js");

const text = "def f():\n    a = 1\n    b = 2\n    return a\n";

function setup(files = ["file:///a.py", "file:///b.py", "file:///c.py"]) {
  docs.clear();
  applied.length = 0;
  beforeOpen = async () => {};
  const store = new ReviewStore();
  const applier = new Applier(store);
  const run = store.createRun("agent", "t", `run-${Math.random()}`);
  const ids = files.map(uri => {
    const snap = store.captureSnapshot(makeDoc(uri, text));
    const res = store.propose(run.runId, snap.snapshotId, { kind: "anchor", oldText: "b = 2", newText: "b = 3" });
    assert.equal(res.ok, true);
    return res.hunkIds[0];
  });
  return { store, applier, runId: run.runId, ids };
}

test("apply writes every accepted hunk in one WorkspaceEdit and refuses a second apply", async () => {
  const { store, applier, runId, ids } = setup();
  ids.forEach(id => store.decide(id, "accepted"));
  store.markFinished(runId);
  const outcome = await applier.applyAccepted(runId);
  assert.equal(outcome.applied, true);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].edits.length, 3);
  for (const doc of docs.values()) assert.equal(doc.text, text.replace("b = 2", "b = 3"));
  assert.equal((await applier.applyAccepted(runId)).applied, false);
  assert.equal(applied.length, 1);
});

test("apply refuses while the agent run is still working", async () => {
  const { store, applier, runId, ids } = setup();
  store.decide(ids[0], "accepted");
  const outcome = await applier.applyAccepted(runId);
  assert.equal(outcome.applied, false);
  assert.equal(applied.length, 0);
  assert.equal(store.getRun(runId).active, true);
  assert.equal(store.getHunk(ids[1]).status, "proposed");
});

test("an invalidation that arrives while documents are opening blocks the write", async () => {
  const { store, applier, runId, ids } = setup();
  ids.forEach(id => store.decide(id, "accepted"));
  store.markFinished(runId);
  beforeOpen = async uri => { if (uri === "file:///b.py") store.invalidateRun(runId); };
  const outcome = await applier.applyAccepted(runId);
  assert.equal(outcome.applied, false);
  assert.equal(applied.length, 0);
  for (const doc of docs.values()) assert.equal(doc.text, text);
});

test("a file edited while a later file is opening is reported as a conflict and nothing is written", async () => {
  const { store, applier, runId, ids } = setup();
  ids.forEach(id => store.decide(id, "accepted"));
  store.markFinished(runId);
  beforeOpen = async uri => { if (uri === "file:///c.py") docs.get("file:///a.py").text = "# mine\n" + text; };
  const outcome = await applier.applyAccepted(runId);
  assert.equal(outcome.applied, false);
  assert.deepEqual(outcome.conflicts, ["a.py"]);
  assert.equal(applied.length, 0);
  assert.equal(docs.get("file:///a.py").text, "# mine\n" + text);
});

test("undo keeps an edit made while another file is opening", async () => {
  const { store, applier, runId, ids } = setup(["file:///a.py", "file:///b.py"]);
  ids.forEach(id => store.decide(id, "accepted"));
  store.markFinished(runId);
  assert.equal((await applier.applyAccepted(runId)).applied, true);
  const after = docs.get("file:///a.py").text;
  beforeOpen = async uri => { if (uri === "file:///b.py") docs.get("file:///a.py").text = after + "# mine\n"; };
  const message = await applier.undoLastApply();
  assert.match(message, /^Not undone: a\.py/);
  assert.equal(applied.length, 1);
  assert.equal(docs.get("file:///a.py").text, after + "# mine\n");
});

test("a hunk accepted during the confirmation prompt is written, marked applied and counted together", async () => {
  const { store, applier, runId, ids } = setup();
  store.decide(ids[0], "accepted");
  store.markFinished(runId);
  const prompt = fake.window.showWarningMessage;
  fake.window.showWarningMessage = async () => { store.decide(ids[1], "accepted"); return "Apply accepted only"; };
  try {
    const outcome = await applier.applyAccepted(runId);
    assert.equal(outcome.applied, true);
    assert.equal(outcome.hunkCount, 2);
    assert.equal(applied[0].edits.length, 2);
    assert.equal(store.getHunk(ids[0]).status, "applied");
    assert.equal(store.getHunk(ids[1]).status, "applied");
    assert.equal(store.getHunk(ids[2]).status, "invalidated");
  } finally {
    fake.window.showWarningMessage = prompt;
  }
});

test("fake dev edit keeps CRLF lines intact", () => {
  assert.equal(fakeEditText("  a\r\n  b\r\n"), "  a\n  FORGELENS_DEMO_INSERTED_LINE\n  b FORGELENS_DEMO_EDIT");
  assert.equal(fakeEditText("  a\n  b\n"), "  a\n  FORGELENS_DEMO_INSERTED_LINE\n  b FORGELENS_DEMO_EDIT");
});

for (const method of ["requestCancel", "invalidateRun"]) {
  test(`${method} before Apply prevents edit submission`, async () => {
    const { store, applier, runId, ids } = setup();
    ids.forEach(id => store.decide(id, "accepted"));
    store.markFinished(runId);
    const cancellation = store[method](runId);
    const applying = applier.applyAccepted(runId);
    assert.equal((await cancellation).cancelled, true);
    assert.equal((await applying).applied, false);
    assert.equal(applied.length, 0);
    for (const doc of docs.values()) assert.equal(doc.text, text);
  });

  test(`${method} waits for a pending applyEdit and reports already applied`, async () => {
    const { store, applier, runId, ids } = setup();
    ids.forEach(id => store.decide(id, "accepted"));
    store.markFinished(runId);
    const original = fake.workspace.applyEdit;
    let submitted;
    const started = new Promise(resolve => { submitted = resolve; });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    fake.workspace.applyEdit = async edit => {
      submitted();
      await pending;
      return original(edit);
    };
    try {
      const applying = applier.applyAccepted(runId);
      await started;
      let settled = false;
      const cancellation = store[method](runId).then(outcome => { settled = true; return outcome; });
      await Promise.resolve();
      assert.equal(settled, false);
      assert.equal(store.getHunk(ids[0]).status, "accepted");
      release();
      assert.equal((await applying).applied, true);
      assert.deepEqual(await cancellation, {
        cancelled: false,
        alreadyApplied: true,
        message: "Changes were already applied; use Undo"
      });
      assert.equal(applied.length, 1);
      for (const id of ids) assert.equal(store.getHunk(id).status, "applied");
      for (const doc of docs.values()) assert.equal(doc.text, text.replace("b = 2", "b = 3"));
    } finally {
      release();
      fake.workspace.applyEdit = original;
    }
  });
}


test("a version-only change blocks every write and names the file", async () => {
  const { store, applier, runId, ids } = setup();
  ids.forEach(id => store.decide(id, "accepted"));
  store.markFinished(runId);
  docs.get("file:///b.py").version++;
  const outcome = await applier.applyAccepted(runId);
  assert.equal(outcome.applied, false);
  assert.deepEqual(outcome.conflicts, ["b.py"]);
  assert.match(outcome.message, /b\.py/);
  assert.equal(applied.length, 0);
  for (const doc of docs.values()) assert.equal(doc.text, text);
});

test("a conflict in a rejected file also blocks the run's accepted edits", async () => {
  const { store, applier, runId, ids } = setup();
  store.decide(ids[0], "rejected");
  ids.slice(1).forEach(id => store.decide(id, "accepted"));
  store.markFinished(runId);
  docs.get("file:///a.py").version++;
  const outcome = await applier.applyAccepted(runId);
  assert.equal(outcome.applied, false);
  assert.deepEqual(outcome.conflicts, ["a.py"]);
  assert.equal(applied.length, 0);
});
