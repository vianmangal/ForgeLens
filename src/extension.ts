import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk" with { "resolution-mode": "import" };
import { Harness, type Failure, type Selection } from "./trueforge/harness";
import { type RunState } from "./shared/types";
import { listenProof, ProofFixture, proofInstruction, proofSpec } from "./proof/connector";
import { AgentPanel } from "./ui/panel";
import { activateReview } from "./review";

let active: Harness | undefined;
let listener: ReturnType<typeof listenProof> | undefined;
let fixture: ProofFixture | undefined;
let panel: AgentPanel;
let start: (model: string, instruction: string, selection?: Selection) => Promise<RunState>;

export function startRun(modelName: string, instruction: string, selection?: Selection) {
  return start(modelName, instruction, selection);
}

export function approve(hunkId: string) { return active?.approve(hunkId) ?? false; }
export function reject(hunkId: string, reason?: string) { return active?.reject(hunkId, reason) ?? false; }
export function cancel() { return active?.cancel() ?? Promise.resolve(); }
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
    const harness = new Harness(client.sessions, proof ? proofSpec(agent) : agent, {
      onState(state) {
        if (active !== harness) return;
        if (state.runId !== shownRun) { shownRun = state.runId; output.appendLine("\nRun " + state.runId + " · " + state.model); }
        panel.stateChanged(state); changes.fire(state);
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
    }, proof ? "forgelens-proof" : "forgelens");
    harness.onRunFailed(failure => {
      if (active !== harness) return;
      output.appendLine("\n" + failure.kind + " · " + failure.message);
      if (failure.kind !== "cancelled") panel.problem(failure.message);
      failures.fire(failure);
    });
    active = harness;
    return harness;
  };
  start = (name, instruction, selection) => {
    if (!name.trim() || !instruction.trim()) throw new Error("Provide a model and an instruction.");
    ensureIdle();
    fixture = undefined;
    const harness = makeHarness(false);
    panel.open();
    return harness.startRun(name, instruction, selection);
  };
  panel = new AgentPanel(context.extensionUri, { run: instruction => startRun(model(), instruction), cancel,
    decide: (id, allowed) => allowed ? approve(id) : reject(id) });
  const review = activateReview(context);
  context.subscriptions.push(review.connectHarness({
    startRun: (instruction, selection) => startRun(model(), instruction, selection),
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
    const harness = makeHarness(true);
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
  try { if (active?.state && active.isActive(active.state.runId)) await cancel(); }
  finally { if (listener) await (await listener).close(); listener = undefined; fixture = undefined; active = undefined; }
}
