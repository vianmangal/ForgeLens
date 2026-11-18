# ForgeLens · TrueForge harness

Person 1's contribution to ForgeLens is a desktop VS Code extension, a TrueForge session client and an isolated MCP fixture for proving the integration before the team's editor tools are available. The extension sends model instructions only to the local TrueForge API. TrueForge calls the configured model and executes its chosen tools.

## Run the proof

Use Node 22.14 or later, desktop VS Code and Ollama. Run the following from this repository in a macOS or Linux shell. The proof uses ports 8790 (TrueForge), 8792 (editor MCP) and 11436 (Ollama). The runtime and SDK versions used here are 0.185.1 and 0.185.0 respectively. The live machine used Node 24.19.0, VS Code 1.146.0 and Ollama 0.34.0. The lockfile pins TypeScript 5.9.3 and MCP SDK 1.32.2.

1. Install, compile, and prepare a disposable workspace.

   ```sh
   npm ci
   npm run build
   npm test
   mkdir -p .local/proof-workspace/.vscode
   cp fixtures/proof.txt .local/proof-workspace/proof.txt
   echo '{"forgelens.primaryModel":"forgelens-local/qwen-proof"}' > .local/proof-workspace/.vscode/settings.json
   ```

2. In a second terminal in this repository, start a local Ollama server. Leave this terminal running.

   ```sh
   OLLAMA_HOST=127.0.0.1:11436 OLLAMA_MODELS="$PWD/.local/models" OLLAMA_NO_CLOUD=1 ollama serve
   ```

3. In another terminal, fetch the 1.4 GB tool-capable proof model, then start TrueForge. Leave this terminal running. The database retains session traces.

   ```sh
   OLLAMA_HOST=127.0.0.1:11436 ollama pull qwen3:1.7b
   HOST=127.0.0.1 SQLITE_PATH="$PWD/.local/proof.sqlite" OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx --yes @truefoundry/trueforge@0.185.1
   ```

4. From the first terminal, register the proof model and connector. Open the VS Code Extension Development Host on the disposable workspace.

   ```sh
   node scripts/configure-proof.mjs
   code --new-window --extensionDevelopmentPath="$PWD" "$PWD/.local/proof-workspace"
   ```

   If the `code` shell command is unavailable, open this repository in VS Code, press F5 with **Launch ForgeLens**, and open the disposable folder in the development window. Trust that folder. In the development window, run **ForgeLens: Start Proof Connector**. TrueForge can now list its three tools at `http://127.0.0.1:8792/mcp`.

5. Run **ForgeLens: Run Harness Proof** from the command palette. The model receives an opaque, run-specific name for the disposable workspace's `proof.txt`. Its MCP read goes to line 2 of the VS Code document, including unsaved buffer changes. Compare the displayed old and new text. Click **Reject**. Start a fresh proof, wait five minutes at the approval, then click **Accept**. The reply streams into the ForgeLens panel and the **ForgeLens** output channel. The proof keeps its proposal in memory.

6. Open **Sessions** in local TrueForge. In each session, inspect the read result, proposal, approval request and recorded user decision. Try a third proof, click **Cancel run** while the approval is pending, and verify the file and buffer stay unchanged. Click **ForgeLens: Cancel Run** in the command palette to cancel from outside the panel.

   The same exercises and a cancellation on the first visible model delta can run inside an isolated VS Code test host. With both servers running, use the absolute path to your VS Code executable if `code` is unavailable. This harness drives the extension commands, waits a real five minutes before allowing the hunk, and inspects the persisted TrueForge events.

   ```sh
   code --wait --user-data-dir="$PWD/.local/test-profile" --extensions-dir="$PWD/.local/test-extensions" --disable-extensions --disable-workspace-trust --extensionDevelopmentPath="$PWD" --extensionTestsPath="$PWD/integration/live-proof.cjs" "$PWD/.local/proof-workspace"
   ```

## Configure the team connector and agent

1. Start Person 3's workspace MCP server in the extension host. In TrueForge **Settings → Connectors → Add MCP Server**, choose a remote HTTP server, name it `forgelens`, and enter the exact loopback URL that Person 3 provides. Use a different port from the proof fixture. Set the connector header credential in TrueForge if the team server requires it. Keep its value in local configuration.
2. In **Settings → Model Providers**, add the team provider and its tool-capable model. The local proof uses a custom OpenAI-compatible provider called `forgelens-local`, base URL `http://127.0.0.1:11436/v1`, model name `qwen-proof`, and upstream ID `qwen3:1.7b`. To inspect or reproduce that exact setup, see `scripts/configure-proof.mjs`. For a remote model, put credentials in TrueForge.
3. In VS Code, set **ForgeLens: Primary Model** to the complete `provider/model` name shown in TrueForge. The port setting takes effect on the next session. Run **ForgeLens: Open Agent Panel**, enter a task and select **Run task**.
4. The extension creates a fresh inline session using `agent/forgelens.agent.json` with the model name resolved from settings. To also create the team's named registry agent for inspection, run the command below once after registering the team connector and model. Its argument is the model name from step 3.

   ```sh
   node scripts/register-agent.mjs forgelens-local/qwen-proof
   ```

The team manifest explicitly exposes six MCP tools. Search, symbol lookup, range reads, edit proposals and hunk approvals are preloaded. The model can discover `run_check` when needed. Only `approve_hunk` requires a human decision. The proof uses its own connector and three bounded tools, so it can run before Person 3 ships the team connector. [TrueForge SDK guide](https://trueforge.dev/api/use-agent) · [Deferred tool loading](https://trueforge.dev/key-features/deferred-tool-loading)

## Teammate integration

The activated extension exports the API below. Modules inside this extension can also import `startRun`, `approve`, `reject`, `cancel`, `registerProposed` and `onRunFailed` from `src/extension.ts`. The shared 1-based contracts live in `src/shared/types.ts`.

| Owner | Integration |
| --- | --- |
| Editor | Call `startRun(modelName, instruction, {path, startLine, endLine, documentVersion, text?})`. Observe `onApproval({runId, hunkId, toolCallId})` to enable per-hunk controls. Call `approve(hunkId)` or `reject(hunkId, reason)`. A true return means the decision was queued. Mark the review decision only on `onDecision({runId, hunkId, allowed})`. Invalidate all review controls on `onInvalidate(runId)`. Native diff, Apply and undo belong to the editor module. |
| Retrieval and tools | Bind each tool invocation to its originating run on the server. After staging a hunk, call `registerProposed(runId, hunkId)` before returning it to the model. A false return means that run cannot accept the proposal. Stop local tools and child checks on invalidation. |
| Models and resilience | `startRun` resolves with terminal run state. `onRunFailed` emits run ID, model, message and kind (`auth`, `network`, `server`, `cancelled` or `tool`). Retain the original input, skip fallback on Cancel and apply the team's side-effect policy before replay. The proof model is independent of the competition model choice. |

The persisted rejection example in `examples/approval-trace.json` shows the actual hunk ID, original tool-call arguments, source event reference and matching user decision from the local proof.

A paused turn releases its stream. The harness keeps the decision state in memory, opens a new subscription at the cursor, sends queued approval answers in one request, and consumes the resumed events. After transport loss, it recovers the existing turn and merges message fragments. The same event ID can carry multiple distinct text deltas. All SDK requests use a 600-second timeout. A completed run with missing approval requests gets one follow-up turn listing just those IDs.

## Editor and review

Inline edit (`Ctrl+Alt+E`), the native diff, per-change Accept/Reject, atomic Apply, undo and conflict detection live in `src/review/`. See [docs/editor-review.md](docs/editor-review.md) for the user flow, the tool integration for `propose_edit`, and the checks.

## What this checkout verifies

`npm test` covers streaming, event correlation, bounded follow-up, interrupted and replayed streams, cancellation, failure classification and the fixture. The live host exercises the installed extension, TrueForge and Ollama. Workspace search, the full review store, budget accounting, fallback policy and the three competition demonstrations depend on the other team contributions.

### Live results on 17 November 2026

These four sessions used the local Qwen3 1.7B proof model. The VS Code host test drove the same approval and cancel APIs exposed to the editor. It checked the persisted TrueForge events and the contents of the disposable workspace file after each run.

| Exercise | Observed result | Local trace |
| --- | --- | --- |
| Reject a proposed edit | The model read line 2 through MCP, proposed one replacement, and received the recorded denial. | [Rejected hunk](http://127.0.0.1:8790/sessions/01m7n2wr0vefdme7dhwkffzbyz) |
| Approve after five minutes | The model initially omitted the gate. The harness issued one follow-up for the missing ID. The same follow-up turn resumed after **300.046 seconds** between the recorded request and allow, and finished successfully. | [Delayed approval](http://127.0.0.1:8790/sessions/01m7n2xda5b9j9jnd9bw8x99wg) |
| Cancel while awaiting approval | TrueForge recorded a cancelled terminal turn, zero approval answers and zero later extension approval or text callbacks. | [Cancelled review](http://127.0.0.1:8790/sessions/01m7n37jqy6q5233pgxm3xgj5t) |
| Cancel during streamed text | The clean-clone extension cancelled after the first 3 visible characters. TrueForge recorded cancellation and the host observed zero later approval or text callbacks. | [Cancelled stream](http://127.0.0.1:8790/sessions/01m7n391z6pfq3fgtr9xhskhqv) |

These links resolve on the machine holding the proof database. Teammates can reproduce the sessions with the steps above. A small model can claim in prose that a hunk was approved before issuing the tool call. The recorded TrueForge decision and the editor's hunk state determine eligibility for Apply.
