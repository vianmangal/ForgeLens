import * as vscode from "vscode";
import type { HunkId, RunId, RunState } from "../shared/types";
import type { Selection } from "../trueforge/harness";
import { Applier, ApplyOutcome } from "./apply";
import { HunkCodeLensProvider, HunkDecorations } from "./codelens";
import { BASE_SCHEME, openDiff, PROPOSED_SCHEME, ReviewDocuments } from "./documents";
import { Decision, instructionLabel, ReviewStore } from "./store";
import { ReviewNode, ReviewTree } from "./tree";

export interface HarnessLink {
  startRun(instruction: string, selection: Selection): Promise<RunState>;
  approve(hunkId: string): boolean;
  reject(hunkId: string, reason?: string): boolean;
  cancel(): Promise<void>;
  onState: vscode.Event<RunState>;
  onDelta: vscode.Event<{ runId: string; text: string }>;
  onApproval: vscode.Event<{ runId: string; hunkId: string; toolCallId: string }>;
  onDecision: vscode.Event<{ runId: string; hunkId: string; allowed: boolean }>;
  onInvalidate: vscode.Event<string>;
  onRunFailed: vscode.Event<{ runId: string; kind: string; message: string }>;
}

export interface ReviewApi {
  store: ReviewStore;
  applier: Applier;
  connectHarness(link: HarnessLink): vscode.Disposable;
  openDiff(runId: RunId, uri: vscode.Uri, hunkId?: HunkId): Promise<void>;
  applyAccepted(runId: RunId): Promise<ApplyOutcome>;
  markRunFinished(runId: RunId): void;
  expectRun(meta: ExpectedRun | undefined): void;
}

export interface ExpectedRun {
  kind: "inline" | "agent";
  label: string;
  instruction: string;
}

interface LineSelection {
  document: vscode.TextDocument;
  startLine: number;
  endLine: number;
  text: string;
}

function hunkIdOf(arg: unknown): HunkId | undefined {
  if (typeof arg === "string") {
    return arg;
  }
  const node = arg as ReviewNode | undefined;
  return node && node.type === "hunk" ? node.hunkId : undefined;
}

export function fakeEditText(text: string): string {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  const indent = (lines[1] ?? lines[0]).match(/^\s*/)?.[0] ?? "";
  const next = [...lines];
  next.splice(1, 0, `${indent}FORGELENS_DEMO_INSERTED_LINE`);
  next[next.length - 1] = `${next[next.length - 1]} FORGELENS_DEMO_EDIT`;
  return next.join("\n");
}

function currentSelection(): LineSelection | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("ForgeLens: open a file and select some code first.");
    return undefined;
  }
  const document = editor.document;
  const sel = editor.selection;
  const startLine = sel.start.line + 1;
  const endLine = sel.isEmpty
    ? startLine
    : sel.end.character === 0 && sel.end.line > sel.start.line
      ? sel.end.line
      : sel.end.line + 1;
  const text = document.getText(new vscode.Range(startLine - 1, 0, endLine, 0));
  return { document, startLine, endLine, text };
}

export function activateReview(context: vscode.ExtensionContext): ReviewApi {
  const store = new ReviewStore();
  const applier = new Applier(store);
  const tree = new ReviewTree(store);
  const lenses = new HunkCodeLensProvider(store);
  const decorations = new HunkDecorations(store);
  const baseDocs = new ReviewDocuments(store, BASE_SCHEME);
  const proposedDocs = new ReviewDocuments(store, PROPOSED_SCHEME);
  const diffOpened = new Set<RunId>();
  const prompted = new Set<RunId>();
  const harnessRuns = new Set<RunId>();
  const lastFailure = new Map<RunId, string>();
  let lastHarnessRun: RunId | undefined;
  let link: HarnessLink | undefined;
  let nextLabel: ExpectedRun | undefined;
  const REJECT_REASON = "Rejected by the developer in ForgeLens review.";

  const treeView = vscode.window.createTreeView("forgelens.review", { treeDataProvider: tree, showCollapseAll: true });

  const pickRun = async (arg: unknown): Promise<RunId | undefined> => {
    const node = arg as ReviewNode | undefined;
    if (node && node.type === "run") {
      return node.runId;
    }
    const active = store.allRuns().filter((r) => r.active);
    if (active.length === 0) {
      vscode.window.showInformationMessage("ForgeLens: there is no active review.");
      return undefined;
    }
    if (active.length === 1) {
      return active[0].runId;
    }
    const pick = await vscode.window.showQuickPick(
      active.map((r) => ({ label: r.label, description: r.runId, runId: r.runId })),
      { placeHolder: "Which ForgeLens run?" }
    );
    return pick?.runId;
  };

  const showApplyOutcome = async (outcome: ApplyOutcome) => {
    if (!outcome.applied) {
      const show = outcome.conflicts.length > 0 ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;
      show(`ForgeLens: ${outcome.message}`);
      return;
    }
    const choice = await vscode.window.showInformationMessage(`ForgeLens: ${outcome.message}`, "Save files", "Undo");
    if (choice === "Save files") {
      for (const doc of vscode.workspace.textDocuments) {
        if (outcome.files.includes(vscode.workspace.asRelativePath(doc.uri, false)) && doc.isDirty) {
          await doc.save();
        }
      }
    } else if (choice === "Undo") {
      vscode.window.showInformationMessage(`ForgeLens: ${await applier.undoLastApply()}`);
    }
  };

  const maybePromptApply = async (runId: RunId) => {
    const run = store.getRun(runId);
    if (!run || !run.active || !run.finished || prompted.has(runId)) {
      return;
    }
    const hunks = store.hunksOfRun(runId);
    if (hunks.length === 0 || hunks.some((h) => h.status === "proposed" || h.status === "approval_requested")) {
      return;
    }
    const accepted = hunks.filter((h) => h.status === "accepted").length;
    if (accepted === 0) {
      return;
    }
    prompted.add(runId);
    const choice = await vscode.window.showInformationMessage(
      `ForgeLens: all changes reviewed. Apply ${accepted} accepted change(s)?`,
      "Apply",
      "Not now"
    );
    if (choice === "Apply") {
      await showApplyOutcome(await applier.applyAccepted(runId));
    }
  };

  const statusBar = vscode.window.createStatusBarItem("forgelens.review.status", vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "ForgeLens Review";

  const refreshStatus = () => {
    const run = store.statusRun();
    if (!run) {
      statusBar.hide();
      return;
    }
    const hunks = store.hunksOfRun(run.runId);
    const accepted = hunks.filter((h) => h.status === "accepted").length;
    const rejected = hunks.filter((h) => h.status === "rejected").length;
    const canApply = store.canApply(run.runId);
    const suffix = store.hasConflict(run.runId) ? " · $(warning) file changed" : canApply ? " · Apply" : "";
    statusBar.text = `ForgeLens: ${hunks.length} changes · ${accepted} accepted · ${rejected} rejected${suffix}`;
    statusBar.tooltip = run.instruction ?? run.label;
    statusBar.command = canApply
      ? { command: "forgelens.applyAccepted", title: "Apply accepted changes", arguments: [{ type: "run", runId: run.runId }] }
      : "forgelens.review.focus";
    statusBar.show();
  };

  const markRunFinished = (runId: RunId) => {
    store.markFinished(runId);
    store.clearBulkChoice(runId);
    void store.closeIfEmpty(runId);
    refreshStatus();
    void maybePromptApply(runId);
  };

  const submit = (id: HunkId, allow: boolean): boolean => {
    if (!link) {
      return false;
    }
    const queued = allow ? link.approve(id) : link.reject(id, REJECT_REASON);
    if (queued) {
      store.markQueued(id);
    }
    return queued;
  };

  const decideAll = (arg: unknown, decision: Decision) => {
    const node = arg as ReviewNode | undefined;
    const runId = node && node.type === "run" ? node.runId : undefined;
    const run = runId ? store.getRun(runId) : undefined;
    if (!runId || !run || !run.active) {
      return;
    }
    const allow = decision === "accepted";
    if (link && harnessRuns.has(runId)) {
      store.setBulkChoice(runId, decision);
      const sent = store.pendingHunkIds(runId, "approval_requested").filter((id) => submit(id, allow)).length;
      const verb = allow ? "accepted" : "rejected";
      vscode.window.showInformationMessage(`ForgeLens: ${sent} change(s) sent as ${verb}. The choice applies only to the changes currently in this review.`);
      return;
    }
    store.decideAll(runId, decision, allow ? undefined : REJECT_REASON);
  };

  const decide = (arg: unknown, allow: boolean) => {
    const id = hunkIdOf(arg);
    const hunk = id ? store.getHunk(id) : undefined;
    if (!id || !hunk) {
      return;
    }
    if (store.isQueued(id)) {
      return;
    }
    if (link && harnessRuns.has(hunk.runId)) {
      if (hunk.status !== "approval_requested") {
        vscode.window.showInformationMessage("ForgeLens: the agent has not asked for approval of this change yet. It will in a moment.");
        return;
      }
      if (!submit(id, allow)) {
        vscode.window.showWarningMessage("ForgeLens: this change can no longer be decided.");
      }
      return;
    }
    if (!store.decide(id, allow ? "accepted" : "rejected", allow ? undefined : REJECT_REASON)) {
      vscode.window.showWarningMessage("ForgeLens: this change can no longer be decided.");
    }
  };

  const runLocal = (label: string, produce: (runId: RunId) => void) => {
    const run = store.createRun("inline", label);
    try {
      produce(run.runId);
      markRunFinished(run.runId);
    } catch (err) {
      store.invalidateRun(run.runId);
      vscode.window.showErrorMessage(`ForgeLens: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const editSelection = async () => {
    if (!link) {
      vscode.window.showErrorMessage("ForgeLens: the TrueForge connection is not ready. For UI testing use \"ForgeLens (Dev): Proposal From Clipboard\".");
      return;
    }
    const target = currentSelection();
    if (!target) {
      return;
    }
    const instruction = await vscode.window.showInputBox({
      title: "ForgeLens: Edit Selection",
      prompt: `What should change in lines ${target.startLine}–${target.endLine}?`,
      placeHolder: "Describe the change in plain language",
      ignoreFocusOut: true
    });
    if (!instruction) {
      return;
    }
    const path = vscode.workspace.asRelativePath(target.document.uri, false);
    const connected = link;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ForgeLens", cancellable: true },
      async (progress, token) => {
        let runId: RunId | undefined;
        const listeners = [
          connected.onDelta((e) => {
            if (e.runId === runId) {
              progress.report({ message: e.text.replace(/\s+/g, " ").slice(-80) });
            }
          }),
          connected.onApproval((e) => {
            if (e.runId === runId) {
              progress.report({ message: "Review the proposed change: Accept or Reject above the code." });
            }
          })
        ];
        token.onCancellationRequested(() => {
          if (runId) {
            void store.requestCancel(runId).then((outcome) => {
              if (outcome.alreadyApplied) {
                vscode.window.showInformationMessage(`ForgeLens: ${outcome.message}`);
              }
            });
          }
        });
        try {
          nextLabel = { kind: "inline", label: instructionLabel(instruction), instruction };
          const finishedState = connected.startRun(instruction, {
            path,
            startLine: target.startLine,
            endLine: target.endLine,
            text: target.text,
            documentVersion: target.document.version
          });
          nextLabel = undefined;
          runId = lastHarnessRun;
          progress.report({ message: "Working on your edit…" });
          const state = await finishedState;
          if (state.status === "failed") {
            vscode.window.showErrorMessage(`ForgeLens: ${lastFailure.get(state.runId) ?? "the run failed."} Your files were not changed.`);
          }
        } catch (err) {
          nextLabel = undefined;
          vscode.window.showErrorMessage(`ForgeLens: ${err instanceof Error ? err.message : String(err)} Your files were not changed.`);
        } finally {
          listeners.forEach((l) => l.dispose());
        }
      }
    );
  };

  const connectHarness = (l: HarnessLink): vscode.Disposable => {
    link = l;
    const subs = [
      l.onState((state) => {
        if (!store.getRun(state.runId)) {
          if (harnessRuns.has(state.runId)) {
            return;
          }
          const meta = nextLabel ?? { kind: "agent" as const, label: `Agent task ${state.runId.slice(0, 8)}`, instruction: undefined };
          nextLabel = undefined;
          store.createRun(meta.kind, meta.label, state.runId, meta.instruction);
          harnessRuns.add(state.runId);
          lastHarnessRun = state.runId;
        }
        if (state.status === "ready_to_apply") {
          markRunFinished(state.runId);
        }
      }),
      l.onApproval((e) => {
        if (store.getHunk(e.hunkId)?.runId !== e.runId) {
          return;
        }
        if (!store.markApprovalRequested(e.hunkId, e.toolCallId)) {
          return;
        }
        const bulk = store.getBulkChoice(e.runId, e.hunkId);
        if (bulk && harnessRuns.has(e.runId)) {
          submit(e.hunkId, bulk === "accepted");
        }
      }),
      l.onDecision((e) => {
        if (store.getHunk(e.hunkId)?.runId === e.runId) {
          store.decide(e.hunkId, e.allowed ? "accepted" : "rejected");
        }
      }),
      l.onInvalidate((runId) => {
        harnessRuns.add(runId);
        void store.invalidateRun(runId).then((outcome) => {
          if (outcome.alreadyApplied) {
            vscode.window.showInformationMessage(`ForgeLens: ${outcome.message}`);
          }
        });
      }),
      l.onRunFailed((f) => lastFailure.set(f.runId, f.message)),
      store.onDidRequestCancel((runId) => {
        if (harnessRuns.has(runId) && runId === lastHarnessRun) {
          void l.cancel();
        }
      })
    ];
    return new vscode.Disposable(() => {
      subs.forEach((s) => s.dispose());
      if (link === l) {
        link = undefined;
      }
    });
  };

  context.subscriptions.push(
    store,
    tree,
    treeView,
    statusBar,
    store.onDidChange(() => refreshStatus()),
    lenses,
    decorations,
    baseDocs,
    proposedDocs,
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseDocs),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposedDocs),
    vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "untitled" }, { scheme: PROPOSED_SCHEME }], lenses),
    vscode.workspace.onDidChangeTextDocument((e) => store.refreshConflicts(e.document)),
    store.onDidAddHunks(async (e) => {
      if (diffOpened.has(e.runId)) {
        return;
      }
      diffOpened.add(e.runId);
      void vscode.commands.executeCommand("forgelens.review.focus");
      if (vscode.workspace.getConfiguration("forgelens").get<boolean>("review.autoOpenDiff", true)) {
        await openDiff(store, e.runId, e.uri, store.getHunk(e.hunkIds[0]));
      }
    }),
    store.onDidDecide((e) => void maybePromptApply(e.runId)),
    vscode.commands.registerCommand("forgelens.noop", () => undefined),
    vscode.commands.registerCommand("forgelens.editSelection", editSelection),
    vscode.commands.registerCommand("forgelens.acceptHunk", (arg: unknown) => decide(arg, true)),
    vscode.commands.registerCommand("forgelens.rejectHunk", (arg: unknown) => decide(arg, false)),
    vscode.commands.registerCommand("forgelens.acceptAll", (arg: unknown) => decideAll(arg, "accepted")),
    vscode.commands.registerCommand("forgelens.rejectAll", (arg: unknown) => decideAll(arg, "rejected")),
    vscode.commands.registerCommand("forgelens.openHunkDiff", async (arg: unknown) => {
      const id = hunkIdOf(arg);
      const hunk = id ? store.getHunk(id) : undefined;
      const base = hunk ? store.getSnapshot(hunk.snapshotId) : undefined;
      if (hunk && base) {
        await openDiff(store, hunk.runId, base.uri, hunk);
      }
    }),
    vscode.commands.registerCommand("forgelens.applyAccepted", async (arg: unknown) => {
      const runId = await pickRun(arg);
      if (runId) {
        await showApplyOutcome(await applier.applyAccepted(runId));
      }
    }),
    vscode.commands.registerCommand("forgelens.cancelRun", async (arg: unknown) => {
      const runId = await pickRun(arg);
      if (runId) {
        const outcome = await store.requestCancel(runId);
        vscode.window.showInformationMessage(`ForgeLens: ${outcome.message}`);
        return outcome;
      }
    }),
    vscode.commands.registerCommand("forgelens.clearFinishedRuns", () => {
      store.clearInactive();
    }),
    vscode.commands.registerCommand("forgelens.undoLastApply", async () => {
      vscode.window.showInformationMessage(`ForgeLens: ${await applier.undoLastApply()}`);
    }),
    vscode.commands.registerCommand("forgelens.dev.fakeProposal", () => {
      const target = currentSelection();
      if (!target) {
        return;
      }
      runLocal(`Dev: fake change ${vscode.workspace.asRelativePath(target.document.uri, false)}`, (runId) => {
        const snapshot = store.captureSnapshot(target.document);
        const result = store.propose(runId, snapshot.snapshotId, { kind: "range", startLine: target.startLine, endLine: target.endLine, newText: fakeEditText(target.text) });
        if (!result.ok) {
          throw new Error(result.error);
        }
      });
    }),
    vscode.commands.registerCommand("forgelens.dev.clipboardProposal", async () => {
      const target = currentSelection();
      if (!target) {
        return;
      }
      const newText = await vscode.env.clipboard.readText();
      runLocal(`Dev: clipboard change ${vscode.workspace.asRelativePath(target.document.uri, false)}`, (runId) => {
        const snapshot = store.captureSnapshot(target.document);
        const result = store.propose(runId, snapshot.snapshotId, { kind: "range", startLine: target.startLine, endLine: target.endLine, newText });
        if (!result.ok) {
          throw new Error(result.error);
        }
      });
    }),
    vscode.commands.registerCommand("forgelens.dev.fakeMultiFileProposal", () => {
      const docs = vscode.workspace.textDocuments.filter((d) => d.uri.scheme === "file" && !d.isClosed).slice(0, 3);
      if (docs.length === 0) {
        vscode.window.showInformationMessage("ForgeLens: open one to three files first.");
        return;
      }
      const run = store.createRun("agent", `Dev: multi-file change (${docs.length} files)`);
      for (const doc of docs) {
        const snapshot = store.captureSnapshot(doc);
        const result = store.propose(run.runId, snapshot.snapshotId, { kind: "range", startLine: 1, endLine: 0, newText: "FORGELENS_DEMO_LINE\n" });
        if (!result.ok) {
          vscode.window.showWarningMessage(`ForgeLens: ${snapshot.path}: ${result.error}`);
        }
      }
      markRunFinished(run.runId);
    })
  );

  return {
    store,
    applier,
    connectHarness,
    openDiff: (runId, uri, hunkId) => openDiff(store, runId, uri, hunkId ? store.getHunk(hunkId) : undefined),
    applyAccepted: (runId) => applier.applyAccepted(runId),
    markRunFinished,
    expectRun: (meta) => {
      nextLabel = meta;
    }
  };
}
