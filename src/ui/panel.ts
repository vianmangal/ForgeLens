import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { ContextRow, RunState } from "../shared/types";
import type { ProofHunk } from "../proof/connector";

type Row = { hunkId: string; detail?: ProofHunk; status: "pending" | "sending" | "accepted" | "rejected" };
export interface PanelActions {
  run(instruction: string): Promise<unknown>;
  cancel(): Promise<void>;
  decide(id: string, allow: boolean): boolean;
  openContext(row: ContextRow): Promise<void>;
}

export class AgentPanel {
  private panel?: vscode.WebviewPanel;
  private state?: RunState;
  private transcript = "";
  private rows = new Map<string, Row>();
  private contextRows: ContextRow[] = [];
  private error = "";

  constructor(private root: vscode.Uri, private actions: PanelActions) {}

  open() {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel("forgelens.agent", "ForgeLens", vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.root, "media")]
    });
    this.panel = panel;
    const nonce = randomBytes(16).toString("hex");
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.root, "media", "panel.js"));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.root, "media", "panel.css"));
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'">
      <link rel="stylesheet" href="${style}"></head><body><main><h1>ForgeLens</h1>
      <form id="form"><label for="task">Repository task</label><textarea id="task" required rows="3" placeholder="Optional context: @file(path/to/file) or @symbol(name)"></textarea>
      <button id="run">Run task</button><button id="cancel" type="button" hidden>Cancel run</button></form>
      <p id="status" role="status"></p><p id="error" role="alert"></p><section id="approvals" aria-label="Hunk approvals"></section>
      <section id="context-section"><h2>Retrieved context</h2><div id="context-rows"></div></section>
      <section id="reply-section" hidden><h2>Model reply</h2><pre id="reply"></pre></section></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
    panel.onDidDispose(() => { this.panel = undefined; });
    panel.webview.onDidReceiveMessage(async message => {
      try {
        if (message.type === "ready") this.refresh();
        if (message.type === "run" && typeof message.text === "string") await this.actions.run(message.text);
        if (message.runId !== this.state?.runId) return;
        if (message.type === "cancel") await this.actions.cancel();
        if (message.type === "decision" && typeof message.allow === "boolean") {
          const row = this.rows.get(message.hunkId);
          if (row?.status === "pending" && this.actions.decide(row.hunkId, message.allow)) {
            row.status = "sending";
            this.refresh();
          }
        }
        if (message.type === "openContext") {
          const row = this.contextRows.find(item =>
            item.path === message.path &&
            item.startLine === message.startLine &&
            item.endLine === message.endLine
          );
          if (row) await this.actions.openContext(row);
        }
      } catch (error) { this.problem(String(error)); }
    });
  }

  stateChanged(state: RunState) {
    if (state.runId !== this.state?.runId) {
      this.rows.clear();
      this.contextRows = [];
      this.transcript = "";
      this.error = "";
    }
    this.state = state;
    this.refresh();
  }

  delta(runId: string, text: string) {
    if (this.state?.runId !== runId) return;
    this.transcript += text;
    void this.panel?.webview.postMessage({ type: "delta", runId, text });
  }

  // Adds budget-accounted retrieval rows for the currently active run.
  context(runId: string, rows: ContextRow[]) {
    if (this.state?.runId !== runId) return;
    this.contextRows = [...this.contextRows, ...rows.filter(row => row.runId === runId)].slice(-100);
    this.refresh();
  }

  approval(id: string, detail?: ProofHunk) {
    this.rows.set(id, { hunkId: id, detail, status: "pending" });
    this.refresh();
  }

  decision(id: string, allowed: boolean) {
    const row = this.rows.get(id);
    if (row) { row.status = allowed ? "accepted" : "rejected"; this.refresh(); }
  }

  invalidate() { this.rows.clear(); this.refresh(); }
  problem(message: string) { this.error = message; this.refresh(); }
  dispose() { this.panel?.dispose(); }

  private refresh() {
    void this.panel?.webview.postMessage({ type: "view", state: this.state, text: this.transcript,
      rows: [...this.rows.values()], contextRows: this.contextRows, error: this.error });
  }
}
