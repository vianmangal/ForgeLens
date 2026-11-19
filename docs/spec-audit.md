# Spec audit: `main` against `docs/spec.md`

Audited on 20 November 2026 against `origin/main` at `b367a05`. Gaps that could be fixed without a live model run are fixed on `fix/spec-gaps`; those rows say **fixed here** and cite the new test. Each test written for a fix was also run against the previous source and failed for the expected reason. Three added tests cover behaviour that already worked and pass on both: `cancelling the run stops a running check promptly…`, `duplicates and over-budget content are recorded…` and `a zero budget sends nothing…`. The `approve_hunk` abort test also passes on both, because it guards against a hang the old code could not have.

Status key: **done** means implemented with automated evidence. **partial** means implemented but missing a piece. **missing** means not implemented. **live** means the code path exists but the spec's claim needs a real model, TrueForge session or recording to verify.

Commands run on the branch: `npm ci`, `npm test` (117 pass, 0 fail; 88 on `main`), `npm run build` (clean), `npm run test:host` (8 pass, 0 fail on VS Code 1.147.0).

## §2–3 Product behaviour and architecture

| Requirement | Status | Evidence | Needed |
|---|---|---|---|
| Inline edit through a contributed keybinding | done | `package.json:181` (`ctrl+alt+e` / `cmd+alt+e`); `src/review/index.ts` `editSelection` | — |
| One panel for prompt, stream and context rows; native diff only when there is something to review | done | `src/ui/panel.ts:26`, `media/panel.js`; `src/review/documents.ts:74` | — |
| Single loopback MCP server, configurable port, disposed on shutdown, clear error if the port is taken | done | `src/mcp/server.ts:33`, `:93`; `src/extension.ts` `deactivate` | — |
| Connector header credential stored outside tracked files | done | `src/mcp/server.ts:40` (constant-time Bearer check); `src/extension.ts` `getMcpAuthToken` (Secret Storage); test `the authenticated connector permits discovery…` | — |
| Live connector proof: real read, deny once, allow once | done (live, 17 Nov) | README "Live results on 17 November 2026"; `examples/approval-trace.json`; `test/proof.test.cjs` | Repeat on the team connector with the competition model (see "Needs a live model") |
| Tested versions recorded in the README | done | `README.md` "Run the proof" | Re-check after the final model is chosen |

## §4 Agent, event and tool contracts

| Requirement | Status | Evidence | Needed |
|---|---|---|---|
| Session from the checked-in definition; model resolved at creation; no direct provider calls | done | `src/trueforge/harness.ts:250`; test `fresh sessions preserve inline agent settings…` | — |
| Instructions: search, inspect neighbouring implementation/test/docs patterns, minimal edits, per-hunk approval, verify after apply; no Flask filenames or solution | done (fixed here) | `agent/forgelens.agent.json`; tests in `test/agent-manifest.test.cjs` | Previously the instructions never said to call `approve_hunk` exactly once per hunk, never named the sibling-command pattern, and said nothing about `budget_exhausted` or snapshots |
| One connector with an explicit tool list; `approve_hunk` gated by literal name | done | `agent/forgelens.agent.json`; test `the connector exposes an explicit tool list…`; test `the registered tools match the manifest…` | — |
| Selective loading: frequent tools preloaded, `run_check` deferred, documented | done (config) / live | `preloadTools` vs `enableTools` (SDK: non-empty `preloadTools` implies `preload: false`); README "The team manifest explicitly exposes six MCP tools" | Show a real `call_tool` discovery of `run_check` in a TrueForge session (B4) |
| `approve_hunk` also gated when the model reaches it through deferred discovery | done (fixed here) | `src/trueforge/harness.ts:87` `approvedHunkId`; test `approve_hunk reached through deferred tool discovery…` | Previously a `call_tool`-wrapped approval was auto-denied, leaving the hunk unreviewable |
| `search_text`: ranked path/line matches, bounded excerpts, truncation flag, ignore rules, excluded dependency folders | done (ranking fixed here) | `src/mcp/tools.ts:155`; `src/context/search.ts:50`, `:583`; tests `search applies the repository case policy…`, `search ranks a definition above…` | Definitions were not ranked above other identifier matches |
| `find_symbol`: provider first, bounded lexical fallback, path/range/evidence | done (scoping fixed here) | `src/context/symbols.ts:109`, `:162`; test `symbol provider results inside dependency or generated folders are dropped` | Provider hits under `.venv`, `node_modules`, `build` and similar folders were previously returned |
| `read_range`: open buffer, numbered 1-based lines, snapshot ID, shortened flag | done (fixed here) | `src/mcp/tools.ts:218`, `:244`; test `read_range shortens ranges past the end of the file…` | Past-EOF and over-300-line requests used to fail instead of being shortened; `totalLines` is now returned |
| `propose_edit`: validate against snapshot; independent hunks with opaque IDs; reject stale, ambiguous, overlapping and out-of-workspace targets with a recoverable explanation | done (stale check fixed here) | `src/mcp/tools.ts:371`, `:405`; `src/review/hunks.ts:212`, `:238`; `src/review/store.ts:248`; tests `propose_edit rejects a snapshot that no longer matches the live buffer…`, `anchor proposals must be unique…`, `overlapping proposals are rejected…` | A snapshot older than the live buffer used to be accepted and only failed at Apply |
| Never accept a model-supplied ID as proof of ownership | done (snapshots fixed here) | Hunks: `src/mcp/tools.ts:433` ownership check. Snapshots: `src/mcp/tools.ts:392`. Test `propose_edit accepts only snapshots that read_range issued to the current run` | Any snapshot ID known to the store was previously accepted |
| `approve_hunk` returns the developer's real decision | done (fixed here) | `src/mcp/tools.ts:68` `waitForDecision` and the queued direction from `src/review/store.ts` `queuedDecision`; tests `approve_hunk waits for the decision…`, `approve_hunk answers at once when the developer's acceptance is queued…`, `…rejection as final…`, `…stops waiting when the MCP request is aborted` | TrueForge runs the allowed call while the harness is still posting the approval, so the tool often answered `pending` and invited a retry |
| `run_check`: configured executable and arguments; shows command, working directory, bounded output, exit code and cancellation | done (command and cwd fixed here) / partial | `src/mcp/tools.ts:471`, `:598`; tests `run_check reports the executed command and working directory`, `cancelling the run stops a running check promptly…` | No per-call argument input: profiles carry fixed arguments, which is stricter than the spec's "validated arguments". Post-apply use depends on the §6 follow-up gap |
| Every result, proposal and approval bound to the originating run; path traversal rejected | done | `src/mcp/server.ts:76`; `src/trueforge/harness.ts:366`; `src/mcp/tools.ts:103`; test `only the active run's announced ForgeLens MCP session owns its tools` | — |
| Stream handling: real deltas, approval correlation, resume from the last event, one `user.tool_approval` per call, reconnect, replay-safe, `turn.done` state | done | `src/trueforge/harness.ts:341`, `:429`; tests `correlates split tool arguments…`, `a dropped live stream replays…`, `losing the stream before its first frame…`, `installed SDK serializes a gated turn…` | — |

## §5 Retrieval and the visible context budget

| Requirement | Status | Evidence | Needed |
|---|---|---|---|
| 6,000 estimated source tokens, ceil(UTF-8 bytes / 4), labelled as estimated source tokens | done (label fixed here) | `package.json:151`; `src/context/budget.ts:42`; `media/panel.js:77`; test `the estimate is one token per four UTF-8 bytes…` | Rows were labelled only "tokens" and did not show the cap. Each row now carries `limitTokens` |
| Invalid budget setting does not break retrieval | done (fixed here) | `src/mcp/tools.ts:42`; test `an invalid configured context budget falls back to the default…` | A negative or non-numeric setting used to make every retrieval tool throw |
| Explicit `@file`/`@symbol` mentions, picker for ambiguity, charged first, bounded excerpt with an omission label | done | `src/context/mentions.ts:126`, `:160`; test `a confirmed fuzzy symbol uses the selected name…` | — |
| Inline selection charged to the budget before tools run | done (fixed here) | `src/context/mentions.ts:218`; `src/trueforge/harness.ts:171`; `src/extension.ts:98`; tests `an inline selection is charged…`, `the selection returned by prepareSelection…`, `the backup run charges the selection to its own run…` | Selection text used to be sent without a row or a charge |
| Rank exact definitions and matching identifiers above plain text; works on arbitrary repositories | done (fixed here) | `src/context/search.ts:583` | See the `search_text` row |
| Cap payloads to the remaining budget, keep whole lines, structured exhaustion, no double-spend under parallel calls | done | Synchronous `reserve` in `src/context/budget.ts:42`; line-by-line fit in `read_range`; tests `concurrent reservations never spend more than the cap`, `duplicates and over-budget content are recorded but never charged or sent` | — |
| Context rows: path/range, query, reason, cost, cumulative total, sent vs excluded, clickable source | done | `media/panel.js` `updateContextRows`; `src/extension.ts:146` | Search candidates cut by `limit` are not listed as rows; only the budget-reserved ones are |
| Acceptance test with two similar filenames and a forced-small budget, independent of Flask | done (added here) | Test `search ranks a definition above a similarly named file's call sites and plain text, then truncates at a small budget` | — |
| Task B: three or more relevant files discovered, with one implementation, test and docs match visible | live | — | Real Task B run (see below) |

## §6 Review, cancellation and recovery

| Requirement | Status | Evidence | Needed |
|---|---|---|---|
| Immutable base, virtual before/after documents, native diff | done | `src/review/documents.ts:6`, `:74`; `src/review/store.ts` snapshots | — |
| The visible Accept/Reject answers the matching gated call | done | `src/review/index.ts` `submit`/`decide`; `src/review/codelens.ts:30`; test `harness-style flow: request, queue, decide, apply` | — |
| A rejected hunk is final; the model cannot silently resubmit it | done (fixed here) | `src/review/store.ts:261`; deny reasons in `src/trueforge/harness.ts` and `src/review/index.ts`; test `the exact change of a rejected hunk cannot be proposed again in the same run` | The identical change used to be accepted again after a rejection |
| Batch apply: revalidate every target, apply none on conflict, one text-only `WorkspaceEdit`, check the result, undo across files, explicit save | done | `src/review/apply.ts:80`, `:97`, `:109`, `:130`; extension-host cases `two hunks…`, `three files…`, `manual edit blocks all files…`, `version-only change blocks Apply…` | — |
| After Apply/Save, resume the TrueForge conversation with the applied and rejected files; label pre-apply checks as a baseline | missing | The run ends at `ready_to_apply` (`src/trueforge/harness.ts`), so no follow-up turn exists. `run_check`'s description now says that an early run is only a baseline | A follow-up turn on the same session after Apply/Save that lists applied and rejected files, then lets the agent call `run_check`. Needs a live model to validate |
| Cancellation: immediate inactive state, invalidated hunks, decisions refused, tools aborted, session cancelled and drained, Apply guarded and serialized | done | `src/trueforge/harness.ts:204`; `src/review/store.ts:388`, `:463`; `src/mcp/tools.ts:598`; tests `cancelling during streaming…`, `cancelling while paused…`, `cancel invalidates pending hunks…`, `serialize runs apply and cancel…`, host case `cancel blocks late decisions…` | — |
| Model recovery: classification, reconnect, no fallback on cancel, backup once on auth, harness retries respected, fresh backup session, primary invalidated, switch announced, side-effect limit, single final error | done / live | `src/trueforge/fallback.ts:87`, `:108`; `test/fallback.test.cjs` (12 cases); host case `fallback invalidates the old review…` | Task C with a deliberately broken primary |

## §7 Fixed tasks

| Requirement | Status | Evidence | Needed |
|---|---|---|---|
| Pinned fixtures at `22d92470`, baseline `pytest tests/test_cli.py -q` | partial | `demo/check_task_a.sh`, `demo/check_task_b.sh`, `demo/demo_app.py` | Owner 4 prepares the three checkouts and records the baseline; these live outside this repository by design |
| Task A inline edit | live | Code path covered by the review and harness tests | Real run with `demo/check_task_a.sh` |
| Task B multi-file change | live | Instructions fixed here; `demo/check_task_b.sh` oracle; `demo/vscode-settings.json` check profile | Real run: ≥3 files, CLI tests pass, masked JSON, `flask --help` lists `config` |
| Task C model failure | live | Fallback tests | Real run with a broken primary; `git status --short` empty before and after |

## §8 Regression and integration checks

| Case | Status | Evidence |
|---|---|---|
| Two separated hunks, accept one, reject one | done | Host `two hunks: accept one, reject one, Apply, native undo`; `test/review-hunks.test.cjs` |
| Three files with independent hunks | done | Host `three files: one Apply and one native undo` |
| User changes one buffer during review | done | Host `manual edit blocks all files and names the conflict`; `test/review-apply.test.cjs` |
| Cancel during streaming, at approval and during a running check | done (check case added here) | `cancelling during streaming…`, `cancelling while paused…`, `cancelling the run stops a running check promptly…` |
| Duplicate approval, stale hunk ID, late primary result after fallback | done | `correlates split tool arguments… denies unrelated, stale and duplicate calls`; `late events from the primary after the switch are ignored`; host `fallback invalidates the old review…` |
| Same-name symbols, ignored directories, oversized and overlapping ranges, budget cap | done (additions here) | Picker test; gitignore test; `symbol provider results inside dependency…`; `read_range shortens…`; overlap test; `concurrent reservations…` |
| Primary auth failure, transient failure, backup failure, cancellation | done | `test/fallback.test.cjs` |
| New session with a second configured model | live | Repeat Task A on the second model and record the outcome |
| Fresh machine following the README only | live | Clean-clone rehearsal |
| Build, typecheck, lint | partial | `npm run build` and `npm run compile` typecheck. No lint script exists; the team needs to decide whether to add ESLint |

## §10 Packaging

| Requirement | Status | Evidence | Needed |
|---|---|---|---|
| Clean-clone steps, versions, launch, connector registration, agent loading, model setup and switching | partial | `README.md`; `docs/models-and-resilience.md` | README "What this checkout verifies" still says search, the review store, budget accounting and fallback depend on other contributions; refresh it after the integrations land |
| Actual agent definition | done | `agent/forgelens.agent.json` | — |
| Example configuration without secrets | done (added here) | `examples/trueforge-connector.json`, `examples/vscode-settings.json`, `demo/vscode-settings.json`; `test/examples.test.cjs` | — |
| Tests and open-source licence | done | `test/`; `LICENSE` | — |
| Demo fixtures separate from extension code | done | `demo/` | — |
| Video, PDF and portal links | missing (team deliverable) | — | Owner 4 |

## Needs a live model or recording to verify

1. Task B end to end with the competition model: discovery of the implementation, test and docs files from the fixed prompt, one `approve_hunk` per hunk, the `check_task_b.sh` oracle, and the TrueForge session on screen.
2. Whether the new instructions keep Task B within the 6,000-token budget on the chosen model. If not, the budget or the 120-line read guidance needs tuning.
3. A real deferred `run_check` discovery in the session, for B4 evidence.
4. The `approve_hunk` race fix against a real TrueForge server. The unit test reproduces the ordering, but the timing on a live server is unobserved.
5. Task A and Task C runs, a second model, and the clean-machine rehearsal.
6. The post-apply follow-up turn, once it is built.
