import * as vscode from "vscode";
import { Hunk, RunId } from "../shared/types";
import { hashText, hunkOffsets, lineStartOffsets } from "./hunks";
import { ReviewStore } from "./store";

export interface ApplyOutcome {
  applied: boolean;
  files: string[];
  hunkCount: number;
  conflicts: string[];
  message: string;
}

interface AppliedFile {
  uri: vscode.Uri;
  before: string;
  afterHash: string;
}

interface LastApply {
  runId: RunId;
  files: AppliedFile[];
}

export class Applier {
  private last: LastApply | undefined;

  constructor(private readonly store: ReviewStore) {}

  applyAccepted(runId: RunId, options: { confirmUndecided?: boolean } = {}): Promise<ApplyOutcome> {
    return this.store.serialize(() => this.doApply(runId, options.confirmUndecided ?? true));
  }

  private async doApply(runId: RunId, confirmUndecided: boolean): Promise<ApplyOutcome> {
    const run = this.store.getRun(runId);
    const empty = (message: string): ApplyOutcome => ({ applied: false, files: [], hunkCount: 0, conflicts: [], message });
    if (!run || !run.active) {
      return empty("This run is no longer active, so nothing was applied.");
    }
    if (!run.finished) {
      return empty("The agent is still working on this run. Apply once it finishes.");
    }
    const hunks = this.store.hunksOfRun(runId);
    const accepted = hunks.filter((h) => h.status === "accepted");
    const undecided = hunks.filter((h) => h.status === "proposed" || h.status === "approval_requested");
    if (accepted.length === 0) {
      return empty("No accepted changes to apply yet. Accept at least one change first.");
    }
    if (undecided.length > 0 && confirmUndecided) {
      const choice = await vscode.window.showWarningMessage(
        `${undecided.length} change(s) are still undecided and will be discarded if you apply now.`,
        { modal: true },
        "Apply accepted only"
      );
      if (choice !== "Apply accepted only") {
        return empty("Apply cancelled.");
      }
      if (!this.store.getRun(runId)?.active) {
        return empty("This run was cancelled while waiting, so nothing was applied.");
      }
    }

    const byUri = new Map<string, Hunk[]>();
    for (const uri of this.store.urisOfRun(runId)) {
      const list = this.store.hunksOfRunAndUri(runId, uri).filter((h) => h.status === "accepted");
      if (list.length > 0) {
        byUri.set(uri.toString(), list);
      }
    }

    const documents = new Map<string, vscode.TextDocument>();
    for (const key of byUri.keys()) {
      documents.set(key, await vscode.workspace.openTextDocument(vscode.Uri.parse(key)));
    }
    if (!this.store.getRun(runId)?.active || accepted.some((h) => h.status !== "accepted")) {
      return empty("This run was cancelled or invalidated before the edit was written, so nothing was applied.");
    }
    const conflicts: string[] = [];
    for (const [key, document] of documents) {
      const base = this.store.baseOf(runId, document.uri);
      if (!base || hashText(document.getText()) !== base.contentHash) {
        conflicts.push(vscode.workspace.asRelativePath(vscode.Uri.parse(key), false));
      }
    }
    if (conflicts.length > 0) {
      return {
        applied: false,
        files: [],
        hunkCount: 0,
        conflicts,
        message: `Nothing was applied: ${conflicts.join(", ")} changed after the proposal was made. Your edits were kept. Ask ForgeLens again to get a fresh proposal.`
      };
    }

    const edit = new vscode.WorkspaceEdit();
    const files: AppliedFile[] = [];
    for (const [key, list] of byUri) {
      const document = documents.get(key)!;
      const base = this.store.baseOf(runId, document.uri)!;
      const offsets = lineStartOffsets(base.text);
      for (const h of list) {
        const { start, end } = hunkOffsets(base.text, h, offsets);
        edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), h.newText);
      }
      files.push({ uri: document.uri, before: base.text, afterHash: "" });
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      return empty("VS Code refused the edit, so nothing was applied.");
    }
    for (const f of files) {
      const document = documents.get(f.uri.toString())!;
      f.afterHash = hashText(document.getText());
    }
    this.last = { runId, files };
    this.store.markApplied(runId, accepted.map((h) => h.id));
    const names = files.map((f) => vscode.workspace.asRelativePath(f.uri, false));
    return {
      applied: true,
      files: names,
      hunkCount: accepted.length,
      conflicts: [],
      message: `Applied ${accepted.length} change(s) in ${names.length} file(s): ${names.join(", ")}. Files are not saved yet. Undo with Ctrl+Z or "ForgeLens: Undo Last Apply".`
    };
  }

  undoLastApply(): Promise<string> {
    return this.store.serialize(async () => {
      const last = this.last;
      if (!last) {
        return "There is no ForgeLens apply to undo.";
      }
      const documents: vscode.TextDocument[] = [];
      for (const f of last.files) {
        documents.push(await vscode.workspace.openTextDocument(f.uri));
      }
      const changed = last.files
        .filter((f, i) => hashText(documents[i].getText()) !== f.afterHash)
        .map((f) => vscode.workspace.asRelativePath(f.uri, false));
      if (changed.length > 0) {
        return `Not undone: ${changed.join(", ")} changed after the apply. Use Ctrl+Z in those files instead.`;
      }
      const edit = new vscode.WorkspaceEdit();
      last.files.forEach((f, i) => {
        const document = documents[i];
        const full = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        edit.replace(f.uri, full, f.before);
      });
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        return "VS Code refused the undo edit.";
      }
      this.store.markReverted(last.runId);
      this.last = undefined;
      return `Undid the last ForgeLens apply in ${last.files.length} file(s). Save to write the original text back to disk.`;
    });
  }
}
