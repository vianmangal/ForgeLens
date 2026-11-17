import * as vscode from "vscode";
import { Hunk, RunId } from "../shared/types";
import { oldLineCount } from "./hunks";
import { sizeLabel } from "./codelens";
import { ReviewStore } from "./store";

export type ReviewNode =
  | { type: "run"; runId: RunId }
  | { type: "file"; runId: RunId; uri: vscode.Uri }
  | { type: "hunk"; hunkId: string };

function hunkIcon(h: Hunk): vscode.ThemeIcon {
  switch (h.status) {
    case "accepted":
      return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"));
    case "rejected":
      return new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("testing.iconFailed"));
    case "applied":
      return new vscode.ThemeIcon("check-all");
    case "invalidated":
      return new vscode.ThemeIcon("circle-slash");
    case "approval_requested":
      return new vscode.ThemeIcon("bell");
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

function hunkRangeLabel(h: Hunk): string {
  if (oldLineCount(h) === 0) {
    return `Insert at line ${h.startLine}`;
  }
  return h.startLine === h.endLine ? `Line ${h.startLine}` : `Lines ${h.startLine}–${h.endLine}`;
}

function excerpt(text: string): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, 12).join("\n");
  return lines.length > 12 ? `${shown}\n…` : shown;
}

export class ReviewTree implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ReviewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: ReviewStore) {
    this.subscription = store.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(node?: ReviewNode): ReviewNode[] {
    if (!node) {
      return this.store.allRuns().map((r) => ({ type: "run", runId: r.runId }));
    }
    if (node.type === "run") {
      return this.store.urisOfRun(node.runId).map((uri) => ({ type: "file", runId: node.runId, uri }));
    }
    if (node.type === "file") {
      return this.store.hunksOfRunAndUri(node.runId, node.uri).map((h) => ({ type: "hunk", hunkId: h.id }));
    }
    return [];
  }

  getTreeItem(node: ReviewNode): vscode.TreeItem {
    if (node.type === "run") {
      const run = this.store.getRun(node.runId);
      const hunks = this.store.hunksOfRun(node.runId);
      const accepted = hunks.filter((h) => h.status === "accepted").length;
      const rejected = hunks.filter((h) => h.status === "rejected").length;
      const applied = hunks.filter((h) => h.status === "applied").length;
      const item = new vscode.TreeItem(run?.label ?? node.runId, vscode.TreeItemCollapsibleState.Expanded);
      const state = !run ? "" : run.reverted ? "undone" : run.active ? "reviewing" : applied > 0 ? "applied" : "closed";
      item.description = `${state} · ${hunks.length} changes · ${accepted} accepted · ${rejected} rejected`;
      item.iconPath = new vscode.ThemeIcon(run?.kind === "agent" ? "hubot" : "edit");
      item.contextValue = run?.active ? "run-active" : "run-inactive";
      item.tooltip = `${node.runId}`;
      return item;
    }
    if (node.type === "file") {
      const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.Expanded);
      item.description = vscode.workspace.asRelativePath(node.uri, false);
      if (this.store.isConflicted(node.runId, node.uri)) {
        item.description += " · changed since proposal";
        item.iconPath = new vscode.ThemeIcon("warning");
      }
      item.contextValue = "file";
      return item;
    }
    const h = this.store.getHunk(node.hunkId);
    if (!h) {
      return new vscode.TreeItem("missing");
    }
    const item = new vscode.TreeItem(hunkRangeLabel(h), vscode.TreeItemCollapsibleState.None);
    const queued = this.store.isQueued(h.id);
    item.description = `${sizeLabel(h)} · ${queued ? "sending decision" : h.status.replace("_", " ")}`;
    item.iconPath = queued ? new vscode.ThemeIcon("sync~spin") : hunkIcon(h);
    item.contextValue = !queued && (h.status === "proposed" || h.status === "approval_requested") ? "hunk-pending" : "hunk-decided";
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${h.path}** · ${hunkRangeLabel(h)}\n\n`);
    if (h.oldText) {
      tip.appendMarkdown("Before:\n");
      tip.appendCodeblock(excerpt(h.oldText));
    }
    tip.appendMarkdown("After:\n");
    tip.appendCodeblock(excerpt(h.newText) || "(removed)");
    item.tooltip = tip;
    item.command = { command: "forgelens.openHunkDiff", title: "Open diff", arguments: [h.id] };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
