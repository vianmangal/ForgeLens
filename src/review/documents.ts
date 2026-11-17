import * as vscode from "vscode";
import { Hunk, RunId } from "../shared/types";
import { applyHunks, mappedStartLine } from "./hunks";
import { ReviewStore } from "./store";

export const BASE_SCHEME = "forgelens-base";
export const PROPOSED_SCHEME = "forgelens-proposed";

export function visibleInProposal(h: Hunk): boolean {
  return h.status !== "rejected" && h.status !== "invalidated";
}

export function reviewUri(scheme: string, runId: RunId, target: vscode.Uri): vscode.Uri {
  const query = new URLSearchParams({ run: runId, file: target.toString() }).toString();
  return vscode.Uri.from({ scheme, path: target.path, query });
}

export function parseReviewUri(uri: vscode.Uri): { runId: RunId; target: vscode.Uri } | undefined {
  const params = new URLSearchParams(uri.query);
  const runId = params.get("run");
  const file = params.get("file");
  if (!runId || !file) {
    return undefined;
  }
  return { runId, target: vscode.Uri.parse(file) };
}

export class ReviewDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly open = new Set<string>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: ReviewStore, private readonly scheme: string) {
    this.subscription = store.onDidChange(() => {
      for (const u of this.open) {
        this.emitter.fire(vscode.Uri.parse(u));
      }
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    this.open.add(uri.toString());
    const parsed = parseReviewUri(uri);
    if (!parsed) {
      return "";
    }
    const base = this.store.baseOf(parsed.runId, parsed.target);
    if (!base) {
      return "";
    }
    if (this.scheme === BASE_SCHEME) {
      return base.text;
    }
    const hunks = this.store.hunksOfRunAndUri(parsed.runId, parsed.target).filter(visibleInProposal);
    try {
      return applyHunks(base.text, hunks);
    } catch {
      return base.text;
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

export function proposedLineOf(store: ReviewStore, hunk: Hunk, target: vscode.Uri): number {
  const visible = store.hunksOfRunAndUri(hunk.runId, target).filter(visibleInProposal);
  return mappedStartLine(hunk, visible.filter((h) => h.id !== hunk.id));
}

export async function openDiff(store: ReviewStore, runId: RunId, target: vscode.Uri, hunk?: Hunk): Promise<void> {
  const left = reviewUri(BASE_SCHEME, runId, target);
  const right = reviewUri(PROPOSED_SCHEME, runId, target);
  const name = target.path.split("/").pop() ?? target.path;
  const count = store.hunksOfRunAndUri(runId, target).length;
  const title = `${name} ↔ ForgeLens proposal (${count} change${count === 1 ? "" : "s"})`;
  const options: vscode.TextDocumentShowOptions = { preview: false, viewColumn: vscode.ViewColumn.Beside };
  if (hunk) {
    const line = Math.max(0, proposedLineOf(store, hunk, target) - 1);
    options.selection = new vscode.Range(line, 0, line, 0);
  }
  await vscode.commands.executeCommand("vscode.diff", left, right, title, options);
}
