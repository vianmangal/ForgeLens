const vscode = require("vscode");
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { setTimeout: wait } = require("node:timers/promises");

exports.run = async function () {
  const suppliedMode = process.env.FORGELENS_PROOF_CASE;
  const modes = suppliedMode ? [suppliedMode] : ["deny", "allow", "cancel", "cancel-stream"];
  const delay = Number(process.env.FORGELENS_APPROVAL_WAIT_MS ?? 300000);
  const ext = vscode.extensions.getExtension("forgelens-team.forgelens");
  const api = await ext.activate();
  const { TrueForge } = await import("@truefoundry/trueforge-sdk");
  const port = vscode.workspace.getConfiguration("forgelens").get("trueforgePort", 8790);
  const client = new TrueForge({ baseUrl: "http://127.0.0.1:" + port, timeoutInSeconds: 600 });
  await vscode.commands.executeCommand("forgelens.startProofConnector");
  const listed = await client.mcpServers.listTools("forgelens-proof");
  const toolNames = listed.data.map(t => t.name);
  assert.deepEqual(toolNames.sort(), ["approve_hunk", "propose_edit", "read_range"]);
  console.log("PROOF connector", JSON.stringify(toolNames));
  if (suppliedMode === "connector") return;
  const fixture = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "proof.txt").fsPath;
  const before = await readFile(fixture, "utf8");
  for (const mode of modes) {
    assert.ok(["deny", "allow", "cancel", "cancel-stream"].includes(mode));
    let text = "", approvals = 0, decided = false, cancelled = false, late = 0;
    let operation = Promise.resolve();
    const subs = [
      api.onApproval(({ hunkId, runId }) => {
        if (cancelled) late++;
        approvals++;
        console.log("PROOF approval", mode, hunkId, runId);
        operation = (async () => {
          if (mode === "allow") await wait(delay);
          await wait(10);
          if (mode === "cancel") {
            cancelled = true;
            await api.cancel();
          } else if (mode === "allow" || mode === "cancel-stream") decided = api.approve(hunkId);
          else decided = api.reject(hunkId, "Developer declined this fixture hunk.");
        })();
      }),
      api.onDelta(event => {
        if (cancelled) { late++; return; }
        text += event.text;
        if (mode === "cancel-stream" && event.text) {
          cancelled = true;
          operation = api.cancel();
        }
      }),
      api.onRunFailed(event => console.log("PROOF classification", event.kind, event.message))
    ];
    try {
      const state = await vscode.commands.executeCommand("forgelens.runProof");
      await operation;
      const log = [];
      for await (const turn of await client.sessions.listTurns(state.sessionId)) {
        for await (const event of await client.sessions.listTurnEvents(state.sessionId, turn.id)) log.push(event);
      }
      const names = log.flatMap(e => e.type === "model.message" ?
        (e.toolCalls ?? []).map(c => c.toolInfo.name) : []);
      const answers = log.filter(e => e.type === "user.tool_approval").map(e => e.approval.status);
      const result = { mode, model: state.model, sessionId: state.sessionId, status: state.status,
        tools: names, answers, approvals, late, streamedCharacters: text.length,
        waitMs: mode === "allow" ? delay : 0 };
      console.log("PROOF result", JSON.stringify(result));
      if (mode !== "cancel-stream") assert.ok(names.includes("read_range") && names.includes("propose_edit") && names.includes("approve_hunk"));
      if (mode !== "cancel-stream") assert.ok(log.some(e => e.type === "tool.response" && e.content.includes("The copper owl counted seven bells.")));
      if (mode !== "cancel-stream") assert.equal(approvals, 1);
      assert.equal(await readFile(fixture, "utf8"), before);
      if (mode === "cancel" || mode === "cancel-stream") {
        assert.equal(state.status, "cancelled");
        if (mode === "cancel") assert.equal(answers.length, 0);
        if (mode === "cancel-stream") assert.ok(text.length > 0);
        assert.ok(log.some(e => e.type === "turn.done" && e.state.status === "cancelled"));
        assert.equal(late, 0);
      } else {
        assert.equal(state.status, "ready_to_apply");
        assert.ok(decided);
        assert.ok(answers.includes(mode));
        assert.ok(text.trim().length > 0);
        assert.ok(log.some(e => e.type === "turn.done" && e.state.status === "done"));
      }
    } finally {
      for (const sub of subs) sub.dispose();
      await api.cancel();
    }
  }
};
