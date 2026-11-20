const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("agent panel gates decisions by current run, hunk ownership and approval status", async () => {
  let receive;
  const views = [];
  const actions = [];
  const hunks = [{ id: "one", path: "src/a", status: "approval_requested" }];
  const webview = { asWebviewUri: String, onDidReceiveMessage: fn => { receive = fn; },
    postMessage: view => views.push(view) };
  const vscode = { window: { createWebviewPanel: () => ({ webview, onDidDispose() {} }) },
    Uri: { joinPath: (...segments) => segments.join("/") }, ViewColumn: { Beside: 2 } };
  const original = Module._load;
  let AgentPanel;
  try {
    Module._load = function(name, ...args) { return name === "vscode" ? vscode : original.call(this, name, ...args); };
    ({ AgentPanel } = require("../dist/ui/panel.js"));
  } finally { Module._load = original; }
  const panel = new AgentPanel("root", { reviewHunks: () => hunks, reviewAction: (...args) => actions.push(args) });
  panel.open();
  panel.stateChanged({ runId: "current" });
  assert.deepEqual(views.at(-1).reviewHunks, hunks);
  const message = { type: "review", runId: "current", hunkId: "one", action: "accept" };
  await receive({ ...message, runId: "stale" });
  await receive({ ...message, hunkId: "other" });
  await receive(message);
  hunks[0].status = "accepted";
  await receive({ ...message, action: "reject" });
  await receive({ ...message, action: "open" });
  hunks[0].status = "invalidated";
  await receive({ ...message, action: "open" });
  assert.deepEqual(actions, [["one", "accept"], ["one", "open"]]);
});
