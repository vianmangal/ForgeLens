import * as vscode from "vscode";
import { Hunk } from "../shared/types";
import { countTextLines, oldLineCount } from "./hunks";
import { parseReviewUri, PROPOSED_SCHEME, proposedLineOf } from "./documents";
import { ReviewStore } from "./store";

function isPending(h: Hunk): boolean {
  return h.status === "proposed" || h.status === "approval_requested";
}

function statusLabel(h: Hunk): string {
  switch (h.status) {
    case "accepted":
      return "$(pass-filled) Accepted";
    case "rejected":
      return "$(circle-slash) Rejected";
    case "applied":
      return "$(check-all) Applied";
    case "invalidated":
      return "$(circle-slash) Discarded";
    default:
      return h.status === "approval_requested" ? "$(bell) Awaiting your decision" : "$(circle-outline) Proposed";
  }
}

export function sizeLabel(h: Hunk): string {
  return `+${countTextLines(h.newText)} −${oldLineCount(h)}`;
}

export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: ReviewStore) {
    this.subscription = store.onDidChange(() => this.emitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    let target = document.uri;
    let hunks: Hunk[];
    let inProposal = false;
    if (document.uri.scheme === PROPOSED_SCHEME) {
      const parsed = parseReviewUri(document.uri);
      if (!parsed) {
        return [];
      }
      target = parsed.target;
      hunks = this.store.hunksOfRunAndUri(parsed.runId, target).filter((h) => h.status !== "invalidated");
      inProposal = true;
    } else {
      hunks = this.store.liveHunksForUri(document.uri);
    }
    const lenses: vscode.CodeLens[] = [];
    hunks.forEach((h, index) => {
      const lineNumber = inProposal ? proposedLineOf(this.store, h, target) : h.startLine;
      const line = Math.min(Math.max(0, lineNumber - 1), Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const conflict = this.store.isConflicted(h.runId, target);
      lenses.push(new vscode.CodeLens(range, {
        title: `$(diff) ForgeLens ${index + 1}/${hunks.length} · ${sizeLabel(h)}`,
        command: "forgelens.openHunkDiff",
        arguments: [h.id]
      }));
      if (conflict) {
        lenses.push(new vscode.CodeLens(range, { title: "$(warning) File changed since this proposal", command: "forgelens.noop" }));
      }
      if (isPending(h) && this.store.isQueued(h.id)) {
        lenses.push(new vscode.CodeLens(range, { title: "$(sync~spin) Sending your decision…", command: "forgelens.noop" }));
      } else if (isPending(h)) {
        lenses.push(new vscode.CodeLens(range, { title: "$(check) Accept", command: "forgelens.acceptHunk", arguments: [h.id] }));
        lenses.push(new vscode.CodeLens(range, { title: "$(close) Reject", command: "forgelens.rejectHunk", arguments: [h.id] }));
      } else {
        lenses.push(new vscode.CodeLens(range, { title: statusLabel(h), command: "forgelens.noop" }));
      }
    });
    return lenses;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

export class HunkDecorations implements vscode.Disposable {
  private readonly pending = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.modifiedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });
  private readonly accepted = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly store: ReviewStore) {
    this.subscriptions.push(
      store.onDidChange(() => this.refreshAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll())
    );
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refresh(editor);
    }
  }

  private refresh(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== "file" && editor.document.uri.scheme !== "untitled") {
      return;
    }
    const hunks = this.store.liveHunksForUri(editor.document.uri);
    const toRange = (h: Hunk) => {
      const start = Math.max(0, h.startLine - 1);
      const end = Math.max(start, h.startLine - 1 + Math.max(0, oldLineCount(h) - 1));
      return new vscode.Range(start, 0, end, 0);
    };
    editor.setDecorations(this.pending, hunks.filter(isPending).map(toRange));
    editor.setDecorations(this.accepted, hunks.filter((h) => h.status === "accepted").map(toRange));
  }

  dispose(): void {
    this.pending.dispose();
    this.accepted.dispose();
    this.subscriptions.forEach((s) => s.dispose());
  }
}
