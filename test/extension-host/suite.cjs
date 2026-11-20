const assert = require("node:assert/strict");
const vscode = require("vscode");

const original = "alpha\nkeep one\nkeep two\nomega\n";
let review;
let workspace;
let sequence = 0;

async function file(name, text = original) {
  const uri = vscode.Uri.joinPath(workspace, `${++sequence}-${name}.txt`);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

async function settle() {
  await review.store.serialize(async () => {});
  await new Promise(resolve => setTimeout(resolve, 50));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Expected review UI state did not arrive");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function reviewTabs() {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
    tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === "forgelens-proposed");
}

async function fakeProposal(document) {
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(document.getText().length));
  const previous = new Set(review.store.allRuns().map(run => run.runId));
  await vscode.commands.executeCommand("forgelens.dev.fakeProposal");
  const run = review.store.allRuns().find(candidate => !previous.has(candidate.runId));
  assert.ok(run, "the dev command must create a review run");
  await settle();
  return run.runId;
}

function stage(runId, document, oldText = "alpha", newText = "ALPHA") {
  const snapshot = review.store.captureSnapshot(document);
  const result = review.store.propose(runId, snapshot.snapshotId, { kind: "anchor", oldText, newText });
  assert.equal(result.ok, true, result.error);
  return result.hunkIds[0];
}

async function nativeUndo(document) {
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  await vscode.commands.executeCommand("undo");
  await settle();
}

function harness() {
  const events = Object.fromEntries(["State", "Delta", "Approval", "Decision", "Invalidate", "RunFailed"]
    .map(name => [name, new vscode.EventEmitter()]));
  const sent = [];
  let cancellations = 0;
  const link = {
    ...Object.fromEntries(Object.entries(events).map(([name, emitter]) => ["on" + name, emitter.event])),
    startRun: async () => { throw new Error("No TrueForge server is used in review host tests"); },
    approve: id => { sent.push([id, true]); return true; },
    reject: id => { sent.push([id, false]); return true; },
    cancel: async () => { cancellations++; }
  };
  const connection = review.connectHarness(link);
  return {
    events, sent,
    get cancellations() { return cancellations; },
    state(runId, status = "streaming") {
      events.State.fire({ runId, status, model: "host-test", sessionId: "host-test" });
    },
    dispose() {
      connection.dispose();
      Object.values(events).forEach(emitter => emitter.dispose());
    }
  };
}

const cases = [
  ["two hunks: accept one, reject one, Apply, native undo", async () => {
    const document = await file("two-hunks");
    const runId = await fakeProposal(document);
    const hunks = review.store.hunksOfRun(runId);
    assert.equal(hunks.length, 2);
    await vscode.commands.executeCommand("forgelens.acceptHunk", hunks[0].id);
    await vscode.commands.executeCommand("forgelens.rejectHunk", hunks[1].id);
    const outcome = await review.applyAccepted(runId);
    assert.equal(outcome.applied, true, outcome.message);
    assert.equal(outcome.hunkCount, 1);
    assert.equal(document.getText(), "alpha\nFORGELENS_DEMO_INSERTED_LINE\nkeep one\nkeep two\nomega\n");
    assert.equal(hunks[0].status, "applied");
    assert.equal(hunks[1].status, "rejected");
    await nativeUndo(document);
    assert.equal(document.getText(), original);
  }],
  ["explicit save writes the applied file and refuses to save a later edit", async () => {
    const doc = await file("verify");
    const run = review.store.createRun("agent", "save");
    const id = stage(run.runId, doc);
    review.store.decide(id, "accepted");
    review.store.markFinished(run.runId);
    assert.equal((await review.applyAccepted(run.runId)).applied, true);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString(), original);
    await review.applier.saveApplied(run.runId);
    assert.equal(doc.isDirty, false);
    const saved = Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString();
    assert.equal(saved, original.replace("alpha", "ALPHA"));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.positionAt(0), "manual ");
    assert.ok(await vscode.workspace.applyEdit(edit));
    await assert.rejects(review.applier.saveApplied(run.runId), /changed/);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString(), saved);
  }],
  ["three files: one Apply and one native undo", async () => {
    const documents = [];
    for (const name of ["multi-a", "multi-b", "multi-c"]) documents.push(await file(name));
    const run = review.store.createRun("agent", "Host multi-file");
    documents.forEach(document => stage(run.runId, document));
    review.markRunFinished(run.runId);
    await vscode.commands.executeCommand("forgelens.acceptAll", { type: "run", runId: run.runId });
    const outcome = await review.applyAccepted(run.runId);
    assert.equal(outcome.applied, true, outcome.message);
    assert.equal(outcome.files.length, 3);
    assert.equal(outcome.hunkCount, 3);
    documents.forEach(document => assert.equal(document.getText(), original.replace("alpha", "ALPHA")));
    await nativeUndo(documents[0]);
    documents.forEach(document => assert.equal(document.getText(), original));
  }],
  ["manual edit blocks all files and names the conflict", async () => {
    const first = await file("conflict-a");
    const second = await file("conflict-b");
    const run = review.store.createRun("agent", "Host conflicts");
    stage(run.runId, first);
    stage(run.runId, second);
    review.markRunFinished(run.runId);
    await vscode.commands.executeCommand("forgelens.acceptAll", { type: "run", runId: run.runId });
    const editor = await vscode.window.showTextDocument(second);
    assert.equal(await editor.edit(builder => builder.insert(new vscode.Position(0, 0), "manual\n")), true);
    await settle();
    assert.equal(review.store.hasConflict(run.runId), true);
    assert.equal(review.store.canApply(run.runId), false);
    const outcome = await review.applyAccepted(run.runId);
    const name = vscode.workspace.asRelativePath(second.uri, false);
    assert.equal(outcome.applied, false);
    assert.deepEqual(outcome.conflicts, [name]);
    assert.ok(outcome.message.includes(name));
    assert.equal(first.getText(), original);
    assert.equal(second.getText(), "manual\n" + original);
  }],
  ["cancel blocks late decisions, Apply and events even after clearing the review", async () => {
    const document = await file("cancel");
    const fixture = harness();
    const runId = "host-cancel";
    await vscode.workspace.getConfiguration("forgelens").update("review.autoOpenDiff", true, vscode.ConfigurationTarget.Workspace);
    try {
      fixture.state(runId);
      const id = stage(runId, document);
      await waitFor(() => reviewTabs().length > 0);
      fixture.events.Approval.fire({ runId, hunkId: id, toolCallId: "cancel-call" });
      const outcome = await vscode.commands.executeCommand("forgelens.cancelRun", { type: "run", runId });
      assert.equal(outcome.cancelled, true);
      assert.equal(fixture.cancellations, 1);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      assert.equal(reviewTabs().length, 0);
      const snapshot = review.store.captureSnapshot(document);
      assert.equal(review.store.propose(runId, snapshot.snapshotId, { kind: "anchor", oldText: "omega", newText: "LATE" }).ok, false);
      await vscode.commands.executeCommand("forgelens.acceptHunk", id);
      assert.equal(review.store.decide(id, "accepted"), false);
      fixture.events.Decision.fire({ runId, hunkId: id, allowed: true });
      fixture.events.Approval.fire({ runId, hunkId: id, toolCallId: "late-call" });
      fixture.events.Delta.fire({ runId, text: "late response" });
      fixture.state(runId, "ready_to_apply");
      assert.equal((await review.applyAccepted(runId)).applied, false);
      assert.equal(review.store.getHunk(id).status, "invalidated");
      assert.equal(fixture.sent.length, 0);
      await vscode.commands.executeCommand("forgelens.clearFinishedRuns");
      fixture.state(runId);
      fixture.state(runId, "ready_to_apply");
      await settle();
      assert.equal(review.store.getRun(runId), undefined);
      assert.equal(review.store.visibleRuns().some(run => run.runId === runId), false);
      assert.equal(reviewTabs().length, 0);
      const lenses = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", document.uri);
      assert.equal(lenses.length, 0);
      assert.equal(document.getText(), original);
    } finally {
      fixture.dispose();
      await vscode.workspace.getConfiguration("forgelens").update("review.autoOpenDiff", false, vscode.ConfigurationTarget.Workspace);
    }
  }],
  ["version-only change blocks Apply after restoring identical text", async () => {
    const document = await file("version-only");
    const runId = await fakeProposal(document);
    await vscode.commands.executeCommand("forgelens.acceptAll", { type: "run", runId });
    const version = document.version;
    const editor = await vscode.window.showTextDocument(document);
    assert.equal(await editor.edit(builder => builder.insert(new vscode.Position(0, 0), "temporary\n")), true);
    await nativeUndo(document);
    assert.equal(document.getText(), original);
    assert.ok(document.version > version);
    assert.equal(review.store.hasConflict(runId), true);
    assert.equal(review.store.canApply(runId), false);
    const outcome = await review.applyAccepted(runId);
    assert.equal(outcome.applied, false);
    assert.deepEqual(outcome.conflicts, [vscode.workspace.asRelativePath(document.uri, false)]);
    assert.equal(document.getText(), original);
  }],
  ["fallback invalidates the old review and ignores its late events", async () => {
    const document = await file("fallback");
    const fixture = harness();
    try {
      fixture.state("host-failed");
      const id = stage("host-failed", document);
      fixture.events.Invalidate.fire("host-failed");
      fixture.events.RunFailed.fire({ runId: "host-failed", kind: "network", message: "test failure" });
      fixture.state("host-fallback");
      await settle();
      fixture.events.Decision.fire({ runId: "host-failed", hunkId: id, allowed: true });
      fixture.state("host-failed", "ready_to_apply");
      assert.equal((await review.applyAccepted("host-failed")).applied, false);
      assert.equal(review.store.getHunk(id).status, "invalidated");
      assert.equal(review.store.getRun("host-fallback").active, true);
      assert.equal(document.getText(), original);
    } finally {
      fixture.dispose();
    }
  }],
  ...[true, false].map(allow => [`${allow ? "Accept" : "Reject"} All sends delayed existing IDs only`, async () => {
    const document = await file("bulk");
    const fixture = harness();
    const runId = `host-bulk-${allow}`;
    try {
      fixture.state(runId);
      const first = stage(runId, document);
      const delayed = stage(runId, document, "omega", "OMEGA");
      fixture.events.Approval.fire({ runId, hunkId: first, toolCallId: "first" });
      await vscode.commands.executeCommand(allow ? "forgelens.acceptAll" : "forgelens.rejectAll", { type: "run", runId });
      assert.deepEqual(fixture.sent, [[first, allow]]);
      const later = stage(runId, document, "keep one", "KEEP ONE");
      fixture.events.Approval.fire({ runId, hunkId: later, toolCallId: "later" });
      fixture.events.Approval.fire({ runId, hunkId: delayed, toolCallId: "delayed" });
      assert.deepEqual(fixture.sent, [[first, allow], [delayed, allow]]);
      for (const id of [first, delayed]) fixture.events.Decision.fire({ runId, hunkId: id, allowed: allow });
      assert.equal(review.store.getHunk(first).status, allow ? "accepted" : "rejected");
      assert.equal(review.store.getHunk(delayed).status, allow ? "accepted" : "rejected");
      assert.equal(review.store.getHunk(later).status, "approval_requested");
      assert.equal(document.getText(), original);
    } finally {
      fixture.dispose();
    }
  }])
];

exports.run = async () => {
  workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(workspace, "runner must provide a temporary workspace");
  const extension = vscode.extensions.getExtension("forgelens-team.forgelens");
  assert.ok(extension, "ForgeLens must be installed in the test host");
  ({ review } = await extension.activate());
  let passed = 0;
  const failures = [];
  console.log(`ForgeLens review host tests on VS Code ${vscode.version}`);
  for (const [name, body] of cases) {
    let timer;
    try {
      await Promise.race([
        body(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Host case timed out after 30 seconds")), 30000); })
      ]);
      passed++;
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL ${name}`, error);
    } finally {
      clearTimeout(timer);
      for (const run of review.store.allRuns()) {
        if (run.active) await review.store.invalidateRun(run.runId);
      }
      await vscode.workspace.saveAll();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      review.store.clearInactive();
    }
  }
  console.log(`ForgeLens extension-host: ${passed} passed, ${failures.length} failed, ${cases.length} total`);
  if (failures.length) throw new AggregateError(failures, "Extension-host tests failed");
};
