import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { Hunk, HunkId, RunId, SourceSnapshot } from "../shared/types";
import { buildProposal, hashText, ProposalRequest, RawHunk } from "./hunks";

export interface SnapshotRecord extends SourceSnapshot {
  uri: vscode.Uri;
  text: string;
}

export interface RunReview {
  runId: RunId;
  kind: "inline" | "agent";
  label: string;
  instruction?: string;
  bulk?: Map<HunkId, Decision>;
  active: boolean;
  finished: boolean;
  reverted: boolean;
  order: HunkId[];
  baseByUri: Map<string, string>;
}

export interface CancelOutcome {
  cancelled: boolean;
  alreadyApplied: boolean;
  message: string;
}

export type Decision = "accepted" | "rejected";

export interface DecisionEvent {
  runId: RunId;
  hunkId: HunkId;
  decision: Decision;
  reason?: string;
  toolCallId?: string;
}

export interface HunksAddedEvent {
  runId: RunId;
  uri: vscode.Uri;
  hunkIds: HunkId[];
}

export type ProposeResult = { ok: true; hunkIds: HunkId[] } | { ok: false; error: string };

export const LABEL_LENGTH = 50;

export function instructionLabel(instruction: string): string {
  return instruction.replace(/\s+/g, " ").trim().slice(0, LABEL_LENGTH);
}

export function newRunId(): RunId {
  return `run-${randomUUID().slice(0, 8)}`;
}

export class ReviewStore implements vscode.Disposable {
  private readonly runs = new Map<RunId, RunReview>();
  private readonly hunks = new Map<HunkId, Hunk>();
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly snapshotIdByKey = new Map<string, string>();
  private readonly conflicted = new Set<string>();
  private readonly queued = new Set<HunkId>();
  private chain: Promise<unknown> = Promise.resolve();

  private readonly changeEmitter = new vscode.EventEmitter<RunId | undefined>();
  private readonly decideEmitter = new vscode.EventEmitter<DecisionEvent>();
  private readonly addedEmitter = new vscode.EventEmitter<HunksAddedEvent>();
  private readonly cancelEmitter = new vscode.EventEmitter<RunId>();

  readonly onDidChange = this.changeEmitter.event;
  readonly onDidDecide = this.decideEmitter.event;
  readonly onDidAddHunks = this.addedEmitter.event;
  readonly onDidRequestCancel = this.cancelEmitter.event;

  captureSnapshot(document: vscode.TextDocument): SnapshotRecord {
    const text = document.getText();
    const contentHash = hashText(text);
    const path = vscode.workspace.asRelativePath(document.uri, false);
    const key = `${document.uri.toString()}#${document.version}#${contentHash}`;
    const existingId = this.snapshotIdByKey.get(key);
    const existing = existingId ? this.snapshots.get(existingId) : undefined;
    if (existing) {
      return existing;
    }
    const snapshotId = `snap-${randomUUID().slice(0, 8)}`;
    const record: SnapshotRecord = { snapshotId, path, documentVersion: document.version, contentHash, uri: document.uri, text };
    this.snapshots.set(snapshotId, record);
    this.snapshotIdByKey.set(key, snapshotId);
    return record;
  }

  getSnapshot(snapshotId: string): SnapshotRecord | undefined {
    return this.snapshots.get(snapshotId);
  }

  createRun(kind: "inline" | "agent", label: string, runId: RunId = newRunId(), instruction?: string): RunReview {
    const run: RunReview = { runId, kind, label, instruction, active: true, finished: false, reverted: false, order: [], baseByUri: new Map() };
    this.runs.set(runId, run);
    this.changeEmitter.fire(runId);
    return run;
  }

  getRun(runId: RunId): RunReview | undefined {
    return this.runs.get(runId);
  }

  allRuns(): RunReview[] {
    return [...this.runs.values()].reverse();
  }

  visibleRuns(): RunReview[] {
    return this.allRuns().filter((r) => r.active || r.order.length > 0);
  }

  latestActiveRun(): RunReview | undefined {
    return this.allRuns().find((r) => r.active);
  }

  statusRun(): RunReview | undefined {
    const live = this.allRuns().filter((r) => r.active);
    return live.find((r) => this.hunksOfRun(r.runId).some((h) => h.status === "proposed" || h.status === "approval_requested" || h.status === "accepted")) ?? live[0];
  }

  hasConflict(runId: RunId): boolean {
    return this.urisOfRun(runId).some((uri) => this.isConflicted(runId, uri));
  }

  canApply(runId: RunId): boolean {
    const run = this.runs.get(runId);
    return !!run && run.active && run.finished && !this.hasConflict(runId) && this.hunksOfRun(runId).some((h) => h.status === "accepted");
  }

  clearInactive(): number {
    let removed = 0;
    for (const run of [...this.runs.values()]) {
      if (run.active) {
        continue;
      }
      for (const id of run.order) {
        this.hunks.delete(id);
        this.queued.delete(id);
      }
      this.clearConflicts(run.runId);
      this.runs.delete(run.runId);
      removed++;
    }
    if (removed > 0) {
      this.changeEmitter.fire(undefined);
    }
    return removed;
  }

  private supersedeOlderRuns(runId: RunId, uriKey: string): void {
    const older: RunId[] = [];
    for (const run of this.runs.values()) {
      if (run.runId === runId) {
        break;
      }
      const snapshotId = run.baseByUri.get(uriKey);
      if (!run.active || !snapshotId) {
        continue;
      }
      const hunks = this.hunksOfRun(run.runId);
      const pendingHere = hunks.some((h) => h.snapshotId === snapshotId && (h.status === "proposed" || h.status === "approval_requested"));
      if (pendingHere && !hunks.some((h) => h.status === "applied")) {
        older.push(run.runId);
      }
    }
    older.forEach((id) => this.requestCancel(id));
  }

  getHunk(hunkId: HunkId): Hunk | undefined {
    return this.hunks.get(hunkId);
  }

  hunksOfRun(runId: RunId): Hunk[] {
    const run = this.runs.get(runId);
    if (!run) {
      return [];
    }
    return run.order.map((id) => this.hunks.get(id)).filter((h): h is Hunk => !!h);
  }

  urisOfRun(runId: RunId): vscode.Uri[] {
    const run = this.runs.get(runId);
    if (!run) {
      return [];
    }
    return [...run.baseByUri.keys()].map((u) => vscode.Uri.parse(u));
  }

  hunksOfRunAndUri(runId: RunId, uri: vscode.Uri): Hunk[] {
    const run = this.runs.get(runId);
    const snapshotId = run?.baseByUri.get(uri.toString());
    if (!run || !snapshotId) {
      return [];
    }
    return this.hunksOfRun(runId)
      .filter((h) => h.snapshotId === snapshotId)
      .sort((a, b) => a.startLine - b.startLine);
  }

  baseOf(runId: RunId, uri: vscode.Uri): SnapshotRecord | undefined {
    const snapshotId = this.runs.get(runId)?.baseByUri.get(uri.toString());
    return snapshotId ? this.snapshots.get(snapshotId) : undefined;
  }

  liveHunksForUri(uri: vscode.Uri): Hunk[] {
    const out: Hunk[] = [];
    for (const run of this.runs.values()) {
      if (!run.active) {
        continue;
      }
      out.push(...this.hunksOfRunAndUri(run.runId, uri).filter((h) => h.status !== "invalidated" && h.status !== "applied"));
    }
    return out;
  }

  isConflicted(runId: RunId, uri: vscode.Uri): boolean {
    return !!this.runs.get(runId)?.active && this.conflicted.has(`${runId}|${uri.toString()}`);
  }

  private clearConflicts(runId: RunId): void {
    for (const flag of [...this.conflicted]) {
      if (flag.startsWith(`${runId}|`)) {
        this.conflicted.delete(flag);
      }
    }
  }

  propose(runId: RunId, snapshotId: string, request: ProposalRequest): ProposeResult {
    const run = this.runs.get(runId);
    if (!run || !run.active) {
      return { ok: false, error: "This run is no longer active." };
    }
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      return { ok: false, error: "Unknown snapshotId. Read the file again to get a fresh snapshot." };
    }
    const key = snapshot.uri.toString();
    const baseId = run.baseByUri.get(key);
    let base = snapshot;
    if (baseId && baseId !== snapshotId) {
      const first = this.snapshots.get(baseId);
      if (!first || first.contentHash !== snapshot.contentHash) {
        return { ok: false, error: `${snapshot.path} changed during this run. Read it again before proposing.` };
      }
      base = first;
    }
    const existing: RawHunk[] = this.hunksOfRun(runId).filter((h) => h.snapshotId === base.snapshotId && h.status !== "invalidated" && h.status !== "rejected");
    const result = buildProposal(base.text, request, existing);
    if (!result.ok) {
      return result;
    }
    const rejected = this.hunksOfRun(runId).filter((h) => h.snapshotId === base.snapshotId && h.status === "rejected");
    const repeated = result.hunks.find((raw) => rejected.some((h) =>
      h.startLine === raw.startLine && h.endLine === raw.endLine && h.oldText === raw.oldText && h.newText === raw.newText));
    if (repeated) {
      return { ok: false, error: `The developer already rejected this exact change at line ${repeated.startLine}. That decision is final; do not propose it again.` };
    }
    run.baseByUri.set(key, base.snapshotId);
    const ids: HunkId[] = [];
    for (const raw of result.hunks) {
      const id = `h-${randomUUID().slice(0, 8)}`;
      this.hunks.set(id, { id, runId, path: base.path, snapshotId: base.snapshotId, ...raw, status: "proposed" });
      run.order.push(id);
      ids.push(id);
    }
    this.supersedeOlderRuns(runId, key);
    this.addedEmitter.fire({ runId, uri: base.uri, hunkIds: ids });
    this.changeEmitter.fire(runId);
    return { ok: true, hunkIds: ids };
  }

  markApprovalRequested(hunkId: HunkId, toolCallId: string): boolean {
    const hunk = this.hunks.get(hunkId);
    const run = hunk ? this.runs.get(hunk.runId) : undefined;
    if (!hunk || !run || !run.active || hunk.status !== "proposed") {
      return false;
    }
    hunk.status = "approval_requested";
    hunk.toolCallId = toolCallId;
    this.changeEmitter.fire(hunk.runId);
    return true;
  }

  markQueued(hunkId: HunkId): void {
    this.queued.add(hunkId);
    const hunk = this.hunks.get(hunkId);
    this.changeEmitter.fire(hunk?.runId);
  }

  isQueued(hunkId: HunkId): boolean {
    return this.queued.has(hunkId);
  }

  decide(hunkId: HunkId, decision: Decision, reason?: string): boolean {
    this.queued.delete(hunkId);
    const hunk = this.hunks.get(hunkId);
    const run = hunk ? this.runs.get(hunk.runId) : undefined;
    if (!hunk || !run || !run.active) {
      return false;
    }
    if (hunk.status !== "proposed" && hunk.status !== "approval_requested") {
      return false;
    }
    run.bulk?.delete(hunkId);
    hunk.status = decision;
    this.decideEmitter.fire({ runId: hunk.runId, hunkId, decision, reason, toolCallId: hunk.toolCallId });
    this.changeEmitter.fire(hunk.runId);
    return true;
  }

  pendingHunkIds(runId: RunId, status?: Hunk["status"]): HunkId[] {
    return this.hunksOfRun(runId)
      .filter((h) => (status ? h.status === status : h.status === "proposed" || h.status === "approval_requested") && !this.queued.has(h.id))
      .map((h) => h.id);
  }

  decideAll(runId: RunId, decision: Decision, reason?: string): HunkId[] {
    const decided: HunkId[] = [];
    for (const id of this.pendingHunkIds(runId)) {
      if (this.decide(id, decision, reason)) {
        decided.push(id);
      }
    }
    return decided;
  }

  setBulkChoice(runId: RunId, decision: Decision): boolean {
    const run = this.runs.get(runId);
    if (!run || !run.active) {
      return false;
    }
    run.bulk = new Map(this.pendingHunkIds(runId).map((id) => [id, decision]));
    return true;
  }

  getBulkChoice(runId: RunId, hunkId: HunkId): Decision | undefined {
    const run = this.runs.get(runId);
    return run && run.active ? run.bulk?.get(hunkId) : undefined;
  }

  clearBulkChoice(runId: RunId): void {
    const run = this.runs.get(runId);
    if (run) {
      run.bulk = undefined;
    }
  }

  markFinished(runId: RunId): void {
    const run = this.runs.get(runId);
    if (run) {
      run.finished = true;
    }
  }

  closeIfEmpty(runId: RunId): Promise<boolean> {
    return this.serialize(async () => {
      const run = this.runs.get(runId);
      if (!run || !run.active || run.order.length > 0) {
        return false;
      }
      return this.invalidateUnlocked(runId).cancelled;
    });
  }

  requestCancel(runId: RunId): Promise<CancelOutcome> {
    return this.serialize(async () => {
      const outcome = this.invalidateUnlocked(runId);
      if (outcome.cancelled) {
        this.cancelEmitter.fire(runId);
      }
      return outcome;
    });
  }

  invalidateRun(runId: RunId): Promise<CancelOutcome> {
    return this.serialize(async () => this.invalidateUnlocked(runId));
  }

  private invalidateUnlocked(runId: RunId): CancelOutcome {
    const run = this.runs.get(runId);
    if (this.hunksOfRun(runId).some((h) => h.status === "applied")) {
      return { cancelled: false, alreadyApplied: true, message: "Changes were already applied; use Undo" };
    }
    if (!run || !run.active) {
      return { cancelled: false, alreadyApplied: false, message: "This run is no longer active; there was nothing to cancel." };
    }
    run.active = false;
    run.bulk = undefined;
    this.clearConflicts(runId);
    for (const hunk of this.hunksOfRun(runId)) {
      this.queued.delete(hunk.id);
      hunk.status = "invalidated";
    }
    this.changeEmitter.fire(runId);
    return { cancelled: true, alreadyApplied: false, message: "Run cancelled. No files were changed by it." };
  }

  markApplied(runId: RunId, hunkIds: HunkId[]): void {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    for (const id of hunkIds) {
      const hunk = this.hunks.get(id);
      if (hunk) {
        hunk.status = "applied";
      }
    }
    for (const hunk of this.hunksOfRun(runId)) {
      if (hunk.status === "proposed" || hunk.status === "approval_requested") {
        hunk.status = "invalidated";
      }
    }
    run.active = false;
    run.bulk = undefined;
    this.clearConflicts(runId);
    this.changeEmitter.fire(runId);
  }

  markReverted(runId: RunId): void {
    const run = this.runs.get(runId);
    if (run) {
      run.reverted = true;
      this.changeEmitter.fire(runId);
    }
  }

  refreshConflicts(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    let changed = false;
    const hash = hashText(document.getText());
    for (const run of this.runs.values()) {
      const snapshotId = run.baseByUri.get(key);
      if (!snapshotId || !run.active) {
        continue;
      }
      const base = this.snapshots.get(snapshotId);
      const flag = `${run.runId}|${key}`;
      const isConflict = !!base && (base.documentVersion !== document.version || base.contentHash !== hash);
      if (isConflict !== this.conflicted.has(flag)) {
        if (isConflict) {
          this.conflicted.add(flag);
        } else {
          this.conflicted.delete(flag);
        }
        changed = true;
      }
    }
    if (changed) {
      this.changeEmitter.fire(undefined);
    }
  }

  serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.decideEmitter.dispose();
    this.addedEmitter.dispose();
    this.cancelEmitter.dispose();
  }
}
