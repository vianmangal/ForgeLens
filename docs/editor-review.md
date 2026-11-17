# Editor and review (Person 2)

`src/review/` owns inline edit, the native diff, per-change decisions, Apply, undo, cancel handling in the UI, and conflict detection. It connects to the harness through `review.connectHarness(...)` in `src/extension.ts`.

## What the user sees

- **ForgeLens: Edit Selection** (`Ctrl+Alt+E`, `Cmd+Alt+E` on macOS) sends the selected lines and an instruction through `startRun`. A progress notification shows the streamed text and has a Cancel button.
- **Diff view.** When the first change arrives, a diff opens beside the file: the original snapshot on the left, the proposal on the right. The real file is not touched.
- **Accept and Reject on each change**, available in three places:
  - CodeLens above the change in the real file.
  - CodeLens in the diff, if `diffEditor.codeLens` is on.
  - Inline buttons in **ForgeLens Review** in the Explorer.
- **How a decision reaches TrueForge.** For harness runs, a click calls `approve` or `reject`. The change shows "sending decision" until `onDecision` confirms it. Before TrueForge asks for approval of a change, a click explains that the request hasn't arrived yet.
- **Run buttons in ForgeLens Review.** An active run shows Accept All, Reject All and Cancel Review. Apply Accepted Changes to Files appears only when the run has finished, at least one change is accepted, and no file in the run has changed since the proposal.
- **Accept All and Reject All per run**:
  - For rehearsal runs, every pending change is decided at once.
  - For harness runs, every change TrueForge has already asked about is sent through `approve` or `reject` and shows "sending decision" until `onDecision` confirms it. The choice is remembered for the run, so a change whose approval request arrives later is decided the same way. The choice is dropped when the run is invalidated, applied or finished.
- **Status bar.** A left-side item reads `ForgeLens: N changes · A accepted · R rejected` for the most recent active run that still has undecided or accepted changes, or else the most recent active run. It adds ` · Apply` once Apply is possible, and clicking it then applies. If a file in the run changed since the proposal, it shows ` · ⚠ file changed` instead, and clicking focuses **ForgeLens Review**. Otherwise clicking focuses **ForgeLens Review**. It is hidden when no run is active.
- **Run list.** Runs with no changes that are no longer active are hidden. A run that finishes without proposing any change is closed, so it disappears. An active run with no changes yet shows "working…". **Clear Finished Runs** in the view title bar removes every run that is no longer active (applied, cancelled or invalidated).
- **One live proposal per file.** When a run proposes changes to a file, any older active run that still has undecided changes in that file, and has applied nothing, is cancelled. Its changes are discarded, so CodeLens never mixes two runs.
- **Original instruction.** The run tooltip shows the instruction. The run label is its first 50 characters. Inline edits store what you typed. Agent-panel runs get theirs through `review.expectRun({kind, label, instruction})`, which `src/extension.ts` calls just before `startRun`.
- **Apply prompt.** When the run reaches `ready_to_apply` and every change is decided, ForgeLens offers to apply the accepted changes.
- **Apply** writes every accepted change in one `WorkspaceEdit`, after checking that each file still matches its snapshot. On a mismatch, nothing is written and the file is named. Apply waits until the run has finished, and nothing is written if the run is cancelled or invalidated while Apply is in progress.
- **Undo:** `Ctrl+Z`, or **ForgeLens: Undo Last Apply**.
- **Cancel or invalidation:** `onInvalidate`, panel Cancel and **ForgeLens: Cancel Review** all invalidate pending changes. They can't be decided or applied afterwards.
- **Dev commands** that work without TrueForge, for rehearsal: **Proposal From Clipboard**, **Fake Proposal From Selection**, **Fake Multi-File Proposal**.

## Integration for Person 3 (tools)

The extension's exported API now includes `review`.

- `read_range`: `const snap = review.store.captureSnapshot(document)` and return `snap.snapshotId`.
- `propose_edit`:

  ```ts
  const result = review.store.propose(runId, snapshotId, { kind: "range", startLine, endLine, newText })
  // or { kind: "anchor", oldText, newText }
  ```

  - On `ok`, call `registerProposed(runId, id)` for each of `result.hunkIds` and return them to the model.
  - On failure, return `result.error` to the model unchanged. It explains how to fix the call.
- The `runId` is the harness run ID. The review store creates a matching run from `onState` before any tool can fire.

## Checks

`npm test` runs the harness tests plus `test/review-hunks.test.cjs`, `test/review-store.test.cjs` and `test/review-apply.test.cjs`.

**By hand:** `npm run build`, then F5. In the development window:

1. Select lines, copy an edited version of them, and run **ForgeLens (Dev): Proposal From Clipboard**.
2. Accept one change, reject another, and apply. Only the accepted change appears.
3. Press `Ctrl+Z`. The file is restored.
4. Edit the file before applying. Apply refuses and keeps your edit.
5. With three files open, run **Fake Multi-File Proposal**. All three apply in one step.
