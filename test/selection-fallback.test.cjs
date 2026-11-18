const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

class Signal {
  listeners = new Set();
  event = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { for (const listener of this.listeners) listener(value); }
}

test("Edit Selection follows only its replacement for progress, approval and cancellation", async () => {
  const commands = new Map();
  const token = new Signal();
  const messages = [];
  const noop = () => {};
  const vscode = {
    EventEmitter: Signal, Range: class {}, Disposable: class {}, ThemeColor: class {},
    OverviewRulerLane: { Left: 1 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 },
    commands: { registerCommand: (name, fn) => commands.set(name, fn) },
    languages: { registerCodeLensProvider: noop },
    workspace: { asRelativePath: () => "a.ts", registerTextDocumentContentProvider: noop, onDidChangeTextDocument: noop },
    window: {
      activeTextEditor: {
        document: { getText: () => "line", version: 1 },
        selection: { start: { line: 0 }, isEmpty: true }
      },
      visibleTextEditors: [], onDidChangeVisibleTextEditors: noop, createTextEditorDecorationType: noop, createTreeView: noop,
      createStatusBarItem: () => ({ show: noop, hide: noop }),
      showInputBox: async () => "Edit this line",
      withProgress: (_options, task) => task({ report: ({ message }) => messages.push(message) },
        { onCancellationRequested: token.event })
    }
  };
  const originalLoad = Module._load;
  let review;
  try {
    Module._load = function (name, ...args) { return name === "vscode" ? vscode : originalLoad.call(this, name, ...args); };
    review = require("../dist/review/index.js").activateReview({ subscriptions: [] });
  } finally {
    Module._load = originalLoad;
  }

  const events = Object.fromEntries(["State", "Delta", "Approval", "Decision", "Invalidate", "RunFailed"].map(name => [name, new Signal()]));
  let finish;
  let cancellations = 0;
  review.connectHarness({
    ...Object.fromEntries(Object.entries(events).map(([name, signal]) => ["on" + name, signal.event])),
    startRun: () => {
      events.State.fire({ runId: "primary", status: "streaming" });
      return new Promise(resolve => { finish = resolve; });
    },
    cancel: async () => { cancellations++; }
  });
  const edit = commands.get("forgelens.editSelection")();
  await new Promise(resolve => setImmediate(resolve));
  events.Invalidate.fire("primary");
  events.State.fire({ runId: "backup", replacesRunId: "primary", status: "streaming" });
  events.Delta.fire({ runId: "primary", text: "late" });
  events.Delta.fire({ runId: "other", text: "unrelated" });
  events.Delta.fire({ runId: "backup", text: "backup text" });
  events.Approval.fire({ runId: "backup", hunkId: "h1", toolCallId: "call" });
  token.fire();
  await review.store.serialize(async () => {});
  assert.equal(cancellations, 1);
  assert.equal(review.store.getRun("backup").active, false);
  assert.equal(review.store.getRun("backup").instruction, "Edit this line");
  assert.deepEqual(messages, ["Working on your edit…", "backup text", "Review the proposed change: Accept or Reject above the code."]);
  finish({ runId: "backup", status: "cancelled" });
  await edit;
  assert.equal(token.listeners.size, 0);
});
