import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk" with { "resolution-mode": "import" };
import { Harness, type Failure, type Selection } from "./trueforge/harness";
import { Fallback } from "./trueforge/fallback";
import { type ContextRow, type RunState } from "./shared/types";
import { listenProof, ProofFixture, proofInstruction, proofSpec } from "./proof/connector";
import { AgentPanel } from "./ui/panel";
import { activateReview, type ReviewApi } from "./review";
import { instructionLabel } from "./review/store";
import { startMcpServer, type RunningMcpServer } from "./mcp/server";
import { clearBudgetForRun, getBudgetForRun, registerForgeLensTools } from "./mcp/tools";
import { budgetSelection, prepareMentionInput } from "./context/mentions";

let active: Harness | undefined;
let review: ReviewApi | undefined;
let mcpServer: RunningMcpServer | undefined;
let listener: ReturnType<typeof listenProof> | undefined;
let fixture: ProofFixture | undefined;
let panel: AgentPanel;
let start: (model: string, instruction: string, selection?: Selection) => Promise<RunState>;
const MCP_AUTH_TOKEN_KEY = "forgelens.mcp.authToken";

// Keeps the connector credential in VS Code Secret Storage instead of project files.
async function getMcpAuthToken(context: vscode.ExtensionContext): Promise<string> {
  const stored = await context.secrets.get(MCP_AUTH_TOKEN_KEY);
  if (stored) return stored;
  const token = randomBytes(32).toString("base64url");
  await context.secrets.store(MCP_AUTH_TOKEN_KEY, token);
  return token;
}

export function startRun(modelName: string, instruction: string, selection?: Selection) {
  return start(modelName, instruction, selection);
}

export function approve(hunkId: string) { return active?.approve(hunkId) ?? false; }
export function reject(hunkId: string, reason?: string) { return active?.reject(hunkId, reason) ?? false; }
export async function cancel() {
  await active?.cancel();
  await review?.store.serialize(async () => {});
}
export function registerProposed(runId: string, hunkId: string) { return active?.registerProposed(runId, hunkId) ?? false; }
const failures = new vscode.EventEmitter<Failure>();
export const onRunFailed = failures.event;

export async function activate(context: vscode.ExtensionContext) {
  const { TrueForge } = await import("@truefoundry/trueforge-sdk");
  const agent: TrueForgeApi.AgentSpec = JSON.parse(await readFile(
    vscode.Uri.joinPath(context.extensionUri, "agent", "forgelens.agent.json").fsPath, "utf8"));
  const output = vscode.window.createOutputChannel("ForgeLens");
  const config = () => vscode.workspace.getConfiguration("forgelens");
  const changes = new vscode.EventEmitter<RunState>();
  const deltas = new vscode.EventEmitter<{ runId: string; text: string }>();
  const approvals = new vscode.EventEmitter<{ runId: string; hunkId: string; toolCallId: string }>();
  const decisions = new vscode.EventEmitter<{ runId: string; hunkId: string; allowed: boolean }>();
  const invalidations = new vscode.EventEmitter<string>();
  context.subscriptions.push(output, changes, deltas, approvals, decisions, invalidations, failures);
  const model = () => {
    const name = config().get<string>("primaryModel", "").trim();
    if (!name) throw new Error("Set forgelens.primaryModel to the provider/model name shown in TrueForge Settings.");
    return name;
  };
  const ensureIdle = () => {
    if (active?.state && active.isActive(active.state.runId)) throw new Error("Finish or cancel the active run first.");
  };
  let shownRun: string | undefined;
  const makeHarness = (proof: boolean) => {
    ensureIdle();
    const old = active?.state;
    if (old?.status === "ready_to_apply") invalidations.fire(old.runId);
    const port = config().get<number>("trueforgePort", 8790);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local TrueForge port.");
    const client = new TrueForge({ baseUrl: "http://127.0.0.1:" + port, timeoutInSeconds: 600, maxRetries: 0 });
    const fallback = new Fallback({
      backupModel: () => config().get<string>("backupModel", ""),
      notice(message) {
        if (active !== harness) return;
        output.appendLine("\n" + message);
        panel.problem(message);
      },
      problem(message) { if (active === harness) panel.problem(message); }
    });
    const harness = new Harness(client.sessions, proof ? proofSpec(agent) : agent, fallback.guard({
      onState(state) {
        if (active !== harness) return;
        if (state.runId !== shownRun) { shownRun = state.runId; output.appendLine("\nRun " + state.runId + " · " + state.model); }
        panel.stateChanged(state); changes.fire(state);
        // Keeps only active runs' ledgers; the panel already retains the displayed rows.
        if (!harness.isActive(state.runId)) clearBudgetForRun(state.runId);
      },
      async prepareInput(runId, content, signal, previousState) {
        const prepared = await prepareMentionInput(content, getBudgetForRun(runId), signal, previousState);
        panel.context(runId, prepared.contextRows);
        return { content: prepared.instruction, state: prepared.state };
      },
      prepareSelection(runId, selection) {
        const prepared = budgetSelection(selection, getBudgetForRun(runId));
        if (prepared.row) panel.context(runId, [prepared.row]);
        return prepared.selection;
      },
      onDelta(runId, text) { if (active === harness) { output.append(text); panel.delta(runId, text); deltas.fire({ runId, text }); } },
      onApproval(runId, hunkId, toolCallId) {
        if (active !== harness) return;
        panel.approval(hunkId, proof ? fixture?.hunk : undefined);
        approvals.fire({ runId, hunkId, toolCallId });
      },
      onDecision(runId, hunkId, allowed) {
        if (active !== harness) return;
        panel.decision(hunkId, allowed); decisions.fire({ runId, hunkId, allowed });
      },
      onInvalidate(runId) {
        if (active !== harness) return;
        panel.invalidate(); invalidations.fire(runId);
      }
    }), proof ? "forgelens-proof" : "forgelens");
    harness.onRunFailed(failure => {
      if (active !== harness) return;
      output.appendLine("\n" + failure.kind + " · " + failure.message);
      failures.fire(failure);
    });
    fallback.attach(harness);
    active = harness;
    return { harness, fallback };
  };
  start = (name, instruction, selection) => {
    if (!name.trim() || !instruction.trim()) throw new Error("Provide a model and an instruction.");
    ensureIdle();
    fixture = undefined;
    const { fallback } = makeHarness(false);
    panel.open();
    return fallback.start(name, instruction, selection);
  };
  review = activateReview(context);
  const editorReview = review;
  panel = new AgentPanel(context.extensionUri, {
    run: instruction => {
      const name = model();
      editorReview.expectRun({ kind: "agent", label: instructionLabel(instruction), instruction });
      try { return startRun(name, instruction); } finally { editorReview.expectRun(undefined); }
    },
    cancel,
    decide: (id, allowed) => allowed ? approve(id) : reject(id),
    reviewHunks: runId => editorReview.store.hunksOfRun(runId).map(hunk => ({
      id: hunk.id, path: hunk.path, startLine: hunk.startLine, endLine: hunk.endLine,
      status: editorReview.store.isQueued(hunk.id) ? "sending" : hunk.status
    })),
    reviewAction: (id, action) => vscode.commands.executeCommand(
      { open: "forgelens.openHunkDiff", accept: "forgelens.acceptHunk", reject: "forgelens.rejectHunk" }[action], id),
    // Opens only a validated workspace-relative source range from a retrieval row.
    openContext: async (row: ContextRow) => {
      const folders = vscode.workspace.workspaceFolders;
      const segments = row.path.replace(/\\/g, "/").split("/").filter(segment => segment && segment !== ".");
      if (!vscode.workspace.isTrusted || folders?.length !== 1 || segments.length === 0 ||
        row.path.startsWith("/") || /^[A-Za-z]:/.test(row.path) || segments.includes("..")) {
        throw new Error("This source path is outside the trusted workspace.");
      }
      let checkedUri = folders[0].uri;
      for (let index = 0; index < segments.length; index += 1) {
        checkedUri = vscode.Uri.joinPath(checkedUri, segments[index]);
        const stat = await vscode.workspace.fs.stat(checkedUri);
        const isLastSegment = index === segments.length - 1;
        if ((stat.type & vscode.FileType.SymbolicLink) !== 0 ||
          (isLastSegment ? (stat.type & vscode.FileType.File) === 0 : (stat.type & vscode.FileType.Directory) === 0)) {
          throw new Error("This source path is no longer a regular workspace file.");
        }
      }
      const document = await vscode.workspace.openTextDocument(checkedUri);
      const start = Math.min(Math.max(0, row.startLine - 1), document.lineCount - 1);
      const end = Math.min(Math.max(start, row.endLine - 1), document.lineCount - 1);
      const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  });
  context.subscriptions.push(editorReview.store.onDidChange(() => panel.refresh()));
  // Starts the local editor-tools endpoint after the review and panel APIs are ready.
  const mcpPort = config().get<number>("mcpPort", 8791);
  try {
    const authToken = await getMcpAuthToken(context);
    mcpServer = await startMcpServer(mcpPort, authToken, sessionId => active?.runForMcpSession(sessionId),
      (server, currentRunId) => registerForgeLensTools(server, {
        review: editorReview,
        currentRunId,
        isRunActive: runId => active?.state?.runId === runId && active.isActive(runId),
        isVerifying: runId => active?.isVerifying(runId) ?? false,
        registerProposed,
        onContextRows: (runId, rows) => panel.context(runId, rows)
      }));
    context.subscriptions.push({ dispose: () => { void mcpServer?.dispose(); } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(message);
  }
  context.subscriptions.push(editorReview.connectHarness({
    startRun: (instruction, selection) => startRun(model(), instruction, selection),
    verifySaved: (runId, files, rejected) => {
      if (!active) throw new Error("No TrueForge session is available.");
      return active.verifySaved(runId, files, rejected);
    },
    approve, reject, cancel, onState: changes.event, onDelta: deltas.event, onApproval: approvals.event,
    onDecision: decisions.event, onInvalidate: invalidations.event, onRunFailed
  }));
  const startConnector = async () => {
    const port = config().get<number>("proofPort", 8792);
    if (!listener) listener = listenProof(port, () => fixture);
    try { await listener; } catch (error) { listener = undefined; throw new Error("Proof connector could not listen on loopback: " + String(error)); }
    return "http://127.0.0.1:" + port + "/mcp";
  };
  const runProof = async () => {
    const name = model();
    await startConnector();
    const workspace = vscode.workspace.workspaceFolders;
    if (!vscode.workspace.isTrusted || workspace?.length !== 1) throw new Error("Open one trusted disposable folder containing proof.txt.");
    const uri = vscode.Uri.joinPath(workspace[0].uri, "proof.txt");
    const readProof = async () => {
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.lineCount < 2 || document.lineAt(0).text !== "ForgeLens harness fixture") {
        throw new Error("Copy fixtures/proof.txt into the root of the disposable workspace.");
      }
      return [document.lineAt(0).text, document.lineAt(1).text, ""].join("\n");
    };
    await readProof();
    const { harness } = makeHarness(true);
    const ownedRun = () => harness.state?.runId;
    fixture = new ProofFixture(readProof,
      () => active === harness && harness.isActive(ownedRun() ?? ""),
      id => active === harness && harness.registerProposed(ownedRun() ?? "", id));
    panel.open();
    return harness.startRun(name, proofInstruction(fixture));
  };
  const command = (id: string, action: () => unknown) => context.subscriptions.push(
    vscode.commands.registerCommand("forgelens." + id, async () => {
      try { return await action(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        panel.problem(message);
        void vscode.window.showErrorMessage(message);
        throw error;
      }
    }));
  command("openPanel", () => panel.open());
  command("copyMcpToken", async () => {
    await vscode.env.clipboard.writeText(await getMcpAuthToken(context));
    void vscode.window.showInformationMessage("ForgeLens MCP token copied. Set the connector Authorization header to Bearer <token>.");
  });
  command("runProof", runProof);
  command("startProofConnector", async () => {
    const url = await startConnector();
    void vscode.window.showInformationMessage("ForgeLens proof connector is listening at " + url);
    return url;
  });
  command("cancel", cancel);
  context.subscriptions.push(panel);
  return { startRun, approve, reject, registerProposed, cancel, onRunFailed, onState: changes.event,
    onDelta: deltas.event, onApproval: approvals.event, onDecision: decisions.event, onInvalidate: invalidations.event,
    isActive: (runId: string) => active?.isActive(runId) ?? false, getState: () => active?.state, review };
}

export async function deactivate() {
  try {
    if (active?.state && active.isActive(active.state.runId)) await cancel();
  } finally {
    const runningMcpServer = mcpServer;
    mcpServer = undefined;
    try {
      await runningMcpServer?.dispose();
    } finally {
      if (listener) await (await listener).close();
      listener = undefined;
      fixture = undefined;
      active = undefined;
    }
  }
}
