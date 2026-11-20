# ForgeLens: Forge-a-thon Round 1 write-up (draft)

## 1. Team

`TODO: team name, members, affiliations.`

| Member | GitHub | Role |
| --- | --- | --- |
| `TODO` | `TODO` | Harness (TrueForge client, streaming, cancellation) |
| `TODO` | `TODO` | Editor (diff, apply, undo, conflicts) |
| `TODO` | `TODO` | Retrieval and MCP tools |
| `TODO` | `TODO` | Verification and submission |
| `TODO` | `TODO` | Models and resilience |

Repository: https://github.com/vianmangal/ForgeLens. Final commit: `TODO`.

## 2. Starting point

ForgeLens was built from scratch in an empty repository (MIT license). It is not a fork. The only external code is its dependencies (the TrueForge SDK 0.185.0, the MCP SDK 1.32.2, `diff` and `ignore`). The Flask demo workspace is a separate checkout of `pallets/flask` 3.1.3 at commit `22d92470`. Demo scripts live in `demo/` and `fixtures/`, apart from the extension in `src/`.

## 3. Architecture on TrueForge

The VS Code extension host owns commands, buffer versions, the context ledger, staged proposals, native diffs and the final edit. It never calls a model provider. It creates TrueForge sessions from `agent/forgelens.agent.json` through the TypeScript SDK on `127.0.0.1:8790`, streams the turn, answers approvals and cancels sessions. TrueForge owns model calls, the tool loop, approval pauses and the trace.

The extension also runs one MCP server bound to `127.0.0.1:8791` and registered in TrueForge as the connector `forgelens`. It requires a random bearer token kept in VS Code Secret Storage, and it refuses `tools/call` unless the MCP session is mapped to the active run. The six tools are:

- `search_text`, `find_symbol`, `read_range`: budgeted discovery and bounded reads of the live editor buffer.
- `propose_edit`: validates against a source snapshot and stages hunks in memory. It never writes.
- `approve_hunk`: gated in TrueForge by its literal name. It returns the decision the developer made in the editor.
- `run_check`: runs only a `forgelens.checkProfiles` entry with the configured Python, with bounded output, a 120 s limit and process-tree kill on cancel. It is also approval-gated.

**TrueForge feature used for B4: deferred tool loading.** The agent manifest preloads five frequent tools and leaves `run_check` discoverable, with approval required for `approve_hunk` and `run_check`. TODO: capture a real session that shows `run_check` being discovered, and the real approval calls, before claiming this on the video.

The review flow separates approval from writing. Approval only marks a hunk eligible. Apply revalidates every file's version and content hash against its snapshot and applies all accepted hunks in one `WorkspaceEdit`, so cancellation before Apply cannot leave a partial patch. Normal VS Code undo reverses it.

## 4. How context is selected

The agent picks its own discovery calls; the extension bounds them.

1. **Explicit mentions.** `@file(path)` and `@symbol(name)` in the prompt are resolved to workspace ranges (up to 300 lines and 200,000 bytes per file) and charged first. Ambiguous symbols prompt the developer.
2. **Search.** `search_text` scans up to 1,200 files within 2.5 s, skips `.gitignore`d paths and folders such as `node_modules`, `.venv` and `build`, and ranks identifier matches ahead of plain text. `find_symbol` uses VS Code's workspace symbol provider and falls back to a bounded lexical search, with an optional path hint.
3. **Budget.** Each run has a ledger of 6,000 *estimated source tokens* (UTF-8 bytes ÷ 4, rounded up; setting `forgelens.contextBudget`). It excludes system instructions, tool schemas and replies. Reservation is synchronous, so parallel tool calls cannot spend the same budget twice. An identical range read again is not resent: it is reported as `duplicate` and costs nothing. Reads that do not fit are cut at whole lines or refused as `over_budget`.
4. **Visible rows.** Every retrieval yields a row with tool, query, signal (`explicit_mention`, `symbol_definition`, `identifier_match`, `text_match`, `path_match`), cost, cumulative total, whether it was sent to the model, and any exclusion. Clicking a row opens the source after re-validating that it is a regular file inside the trusted workspace.

Ranking is lexical. There is no vector index and no relevance model beyond identifier versus plain text.

## 5. Model setup

| Role | Provider | Model | Hosting | Approximate cost |
| --- | --- | --- | --- | --- |
| Primary | TrueForge built-in `google-gemini` | `gemini-3-1-flash-lite` | Google cloud, free tier | `TODO` |
| Backup | TrueForge custom provider `ollama` | `qwen3:8b` | Local through Ollama | `TODO` |

They are separate providers with separate credentials. Keys are entered only in TrueForge, never in the repository. To switch, change `forgelens.primaryModel` and `forgelens.backupModel` to the full `provider/model` names shown in TrueForge ([`examples/models.example.md`](../examples/models.example.md)). Both models passed TrueForge's built-in tool-call test on 17 Nov 2026. They have not yet been run against the ForgeLens connector: `TODO: record the actual model and outcome of Tasks A, B and C.` Three other candidates failed tool use in testing (see `docs/models-and-resilience.md`).

**Fallback.** Failures are classified as `auth` (401/403, or a 400 whose message says the key is invalid, which is what Gemini returns), `server` (429/5xx), `network`, `tool` and `cancelled`. TrueForge's own retries come first; the client uses none. An auth, server or network failure starts one fresh session on the backup with the same instruction and selection, invalidates the primary's hunks and announces the switch. Cancellation, tool errors and a possibly already-executed `run_check` never trigger it. If the backup also fails the run stops with one error.

## 6. Scorecard

Timestamps come from the final video edit. Claims describe what the code and tests support today; items marked unverified await a recorded run.

| Criterion | Pts | Video | Claim |
| --- | ---: | --- | --- |
| A1 Inline edit | 10 | TODO timestamp | `Cmd+Alt+E` sends the selected lines and an instruction through the harness; changes open as a native diff with per-change Accept/Reject. Live Task A result unverified. |
| A2 Agent mode | 10 | TODO timestamp | The panel starts a TrueForge run that uses the six tools and the same review flow. Whether Task B reaches three or more files is unverified. |
| A3 Streaming and cancellation | 10 | TODO timestamp | Real `model.message.delta` text streams into the panel. On 17 Nov a live cancel after the first 3 characters and a cancel during approval each recorded a cancelled turn and no later callbacks (local proof model). |
| B1 Context assembly | 15 | TODO timestamp | The ledger charges every retrieval against 6,000 estimated tokens and shows reasons and exclusions in clickable rows. No dedicated test of budget capping or ranking exists yet. |
| B2 Diff safety | 10 | TODO timestamp | Accept/Reject per hunk; one atomic Apply with version-and-hash conflict refusal; native undo. 88 unit tests pass, and 8 extension-host cases passed earlier, both using a fixture event source. |
| B3 Resilience | 10 | TODO timestamp | Automatic one-shot fallback to the backup is implemented and unit-tested, with a clean workspace on failure. A live fallback with real credentials is unverified. |
| B4 TrueForge integration | 10 | TODO timestamp | Authenticated MCP connector, gated `approve_hunk`, and deferred `run_check` in the manifest. Live approval is proven only with the proof connector. A session showing the team connector is unverified. |
| C1 Video | 10 | TODO timestamp | `TODO: runtime ≤ 4:00, Tasks A, B, C in order.` |
| C2 Write-up | 15 | TODO timestamp | Sections 1–8 in this document, filled from the code. Items marked TODO remain. |

## 7. Tools used

- **Runtime:** TrueForge 0.185.1 (local) with its SDK 0.185.0; VS Code extension API; MCP SDK 1.32.2; Ollama for the backup model.
- **Libraries:** `diff` 8.0.4, `ignore`, `zod`, `esbuild` 0.28.2, TypeScript 5.9.3, `@vscode/test-electron` 3.1.0.
- **Demo:** Flask 3.1.3 (`22d92470`), `uv`, `pytest`.
- **AI coding tools:** `TODO: list the assistants used and for what.`

## 8. Known limitations and what you would do with another month

- **Live evidence is thin.** The real-model proof used a 1.7B local model and the proof connector. The team connector with Gemini and with `qwen3:8b` has not been run on Tasks A, B or C. The recorded runs are still to do.
- **Retrieval is lexical and untested at the edges.** There is no vector index, and no test with similarly named files and a tiny budget. The token estimate is a byte heuristic.
- **`run_check` is hard to reach.** The model is not told the profile IDs, so it must guess `checkId`. It runs only configured Python profiles. A check before Apply is not run against candidate trees.
- **Scope.** One trusted workspace and one active run; not packaged for the Marketplace, no CI.
- **Small models misreport approvals,** so Apply trusts only the recorded decision and the editor's hunk state.
- **Fallback is one hop** and relies on TrueForge's retries for transient failures.
- **With another month:** run the full A/B/C matrix on both models and a third provider, add a candidate-tree test runner, an explorer subagent and semantic retrieval, add the tests above, publish a packaged extension with CI, and advertise check profiles to the model.
