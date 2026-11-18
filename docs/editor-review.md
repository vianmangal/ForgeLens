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
  - For harness runs, every change TrueForge has already asked about is sent through `approve` or `reject` and shows "sending decision" until `onDecision` confirms it. The choice is captured only for the pending hunk IDs that exist at the click. Their delayed approval requests receive that decision; hunks proposed after the click remain undecided. The choice is dropped when the run is invalidated, applied or finished.
- **Status bar.** A left-side item reads `ForgeLens: N changes · A accepted · R rejected` for the most recent active run that still has undecided or accepted changes, or else the most recent active run. It adds ` · Apply` once Apply is possible, and clicking it then applies. If a file in the run changed since the proposal, it shows ` · ⚠ file changed` instead, and clicking focuses **ForgeLens Review**. Otherwise clicking focuses **ForgeLens Review**. It is hidden when no run is active.
- **Run list.** Runs with no changes that are no longer active are hidden. A run that finishes without proposing any change is closed, so it disappears. An active run with no changes yet shows "working…". **Clear Finished Runs** in the view title bar removes every run that is no longer active (applied, cancelled or invalidated).
- **One live proposal per file.** When a run proposes changes to a file, any older active run that still has undecided changes in that file, and has applied nothing, is cancelled. Its changes are discarded, so CodeLens never mixes two runs.
- **Original instruction.** The run tooltip shows the instruction. The run label is its first 50 characters. Inline edits store what you typed. Agent-panel runs get theirs through `review.expectRun({kind, label, instruction})`, which `src/extension.ts` calls just before `startRun`.
- **Apply prompt.** When the run reaches `ready_to_apply` and every change is decided, ForgeLens offers to apply the accepted changes.
- **Apply** writes every accepted change in one `WorkspaceEdit`, after checking both the document version and content hash of every file in the run against its snapshot. A version bump with identical text, including editing and undoing back to the original text, is a conflict. The tree, CodeLens and status bar use the same version-and-hash rule. On a mismatch, nothing is written and the file is named. Apply waits until the run has finished. Cancellation, harness invalidation, and fallback invalidation share the store serialization lock with the final Apply validation and `workspace.applyEdit()`. Cancellation before that commit prevents submission. Once Apply holds the lock, it finishes and marks the hunks applied before cancellation resolves with "Changes were already applied; use Undo". Document opening and the confirmation prompt happen before the commit lock, so cancellation can still prevent an edit during preparation.
- **Undo:** `Ctrl+Z`, or **ForgeLens: Undo Last Apply**.
- **Cancel or invalidation:** `onInvalidate`, panel Cancel and **ForgeLens: Cancel Review** all invalidate pending changes. They can't be decided or applied afterwards. Await `store.requestCancel(runId)` or `store.invalidateRun(runId)` for a `CancelOutcome`; never wrap either call in `store.serialize`, since they acquire that lock internally.
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

## Extension-host checks

Run `npm run test:host` on macOS. It builds the extension and uses `@vscode/test-electron` to launch an isolated VS Code test host with a temporary workspace, profile and extensions directory. The suite runs unattended, with no TrueForge or Ollama server and no manual clicks. Electron still requires a macOS desktop session. The runner deletes the temporary workspace and profile when the host exits; the downloaded VS Code cache stays under ignored `.local/vscode-test/`.

The eight cases use the activated extension's exported `review` API, the dev proposal command, the review commands and real VS Code documents. They cover:

- Two hunks in one file, accept one and reject one, then Apply and native `undo`.
- Three files in one Apply, restored together by one native `undo`.
- A manual edit blocking every write and naming the conflicted file.
- Cancel Review blocking late decisions and Apply, with late events unable to recreate a cleared run, reopen a diff or restore CodeLens.
- A version-only change after editing and native undo blocking Apply.
- Fallback invalidating the old run while preserving the replacement run.
- Accept All and Reject All each retaining delayed approvals only for existing hunk IDs.

Only the TrueForge event source is a local fixture passed through `review.connectHarness`; VS Code's editing, diff, command and undo APIs are real. The fixture does not establish real MCP/TrueForge integration. Late state events for a known, cleared harness run are ignored.

The first run downloads stable VS Code and requires network access. Set `VSCODE_VERSION` to select another release, or `VSCODE_EXECUTABLE_PATH` to an existing VS Code executable to run offline. Download or launch failures exit nonzero; they must not be reported as passing host tests. See the [VS Code extension testing guide](https://code.visualstudio.com/api/working-with-extensions/testing-extension).

Verified on macOS with installed VS Code 1.146.0: **8 passed, 0 failed**. The unit suite passes **60 tests**. This verifies the editor client; the real Person 3 tool integration remains a separate check.

## Agent-panel layout proposal

The [proposal on PR #1](https://github.com/vianmangal/ForgeLens/pull/1#issuecomment-6977657430) keeps the native, keyboard-accessible ForgeLens Review Explorer as the grouped multi-file list. Existing panel approval rows continue to submit through `approve`/`reject` and synchronize with review via `onDecision`. Vian can optionally add an **Open review** link by adding `enableCommandUris: ["forgelens.review.focus"],` to the webview options and `<a href="command:forgelens.review.focus">Open review</a>` to its HTML. Layout agreement and the optional panel change are pending Vian; no panel or media files were changed here.

## Person 3 integration audit, 18 November 2026

After `git fetch --all`, the remote branches were `main`, `feat/editor-review`, `feat/models-resilience`, `feat/retrieval-mcp`, and `feat/verification-submission`. `origin/HEAD` points to `origin/main`.

`origin/feat/retrieval-mcp` still points to `20e3199f57a2dc643abfe73afef9421734ba06b8`. Its only `read_range` and `propose_edit` implementations are the isolated proof fixture. They return snapshot/hunk IDs and register the fixture hunk against the owning harness run before returning it, rejecting inactive owners. They do not call `review.store.captureSnapshot(document)` or `review.store.propose(runId, snapshotId, request)`, register the review store's returned hunk IDs, or propagate its errors. That branch does not yet export `review`.

The [PR audit comment](https://github.com/vianmangal/ForgeLens/pull/1#issuecomment-6977666371) links the exact registration and tool code. The real workspace tool → review → TrueForge approval integration remains pending Person 3's implementation and a joint live check. The remote branch was inspected without checkout or modification.
