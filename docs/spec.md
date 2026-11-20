# ForgeLens | Round 1 implementation specification

**Build target:** A TypeScript extension for desktop VS Code that uses local TrueForge to discover relevant code, propose edits across files, and let a developer review each hunk before applying it. The distinctive feature is a visible account of **which source ranges the agent used, how it found them, and what fit in its context budget**.

Round 1 requires three accessible links on the Techfest Competition Portal: the public GitHub repository, a public-viewable video of at most four minutes, and a 1–3 page PDF. This engineering spec is a handoff to the implementer. The competition PDF is a separate deliverable written from the finished build. [Official event](https://techfest.org/competitions/forge-a-thon) · [Problem statement, pp. 4–10](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf)

## 1. Start here

1. Start from scratch in an empty project folder named `forgelens`. Initialize a local Git repository there. This folder will contain the team's VS Code extension. TrueForge runs locally as its agent harness, and a separate Flask checkout will serve as the demo workspace.
2. Start local TrueForge as described in §3 and configure one available tool-capable model. Scaffold a minimal TypeScript VS Code extension with a manifest, activation entry point, build script, and Extension Development Host launch configuration. Confirm it launches, then implement the **live connector proof** in §3. Record the tested dependency versions in the README. If credentials are missing, build and test the editor, retrieval, fixtures, and event handling independently. Keep live-model checks explicitly pending until a real provider runs them.
3. Finish one complete inline edit through TrueForge. Then use the same client, tools, hunk store, and approval path for agent mode. Follow the milestones in §9. The judging evidence in §10 defines completion.

**Working assumptions.** Support a local desktop VS Code window with one trusted Git workspace and one active ForgeLens run. Support editing existing UTF-8 text files, including unsaved buffer contents. This covers all three fixed tasks. Keep model names configurable, use a second independently configured connection when available, and document actual model access and cost. Team names, provider credentials, recordings, and public URLs are inputs from the team.

**Scope cuts.** Defer arbitrary shell execution, pre-approval test runs on candidate trees, an explorer subagent, vector indexing, hosted infrastructure, and Marketplace release. Use bounded workspace search, native diffs, selective tool loading, and tests on the accepted changes. The organizer also excludes tab completion, model training/hosting, accounts, and deployment from scoring. [Brief, pp. 1–3](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf)

## 2. Product behavior

| Entry point | What the developer does | Observable result |
|---|---|---|
| Inline edit | Select a function, invoke **ForgeLens: Edit Selection** through a contributed keybinding or the command palette, enter an instruction. | The selected file and range stay visible. Tokens stream. A proposed diff opens in the editor with Accept and Reject on each hunk. The original document stays intact throughout preview. |
| Agent panel | Enter a repository-level task. Optionally pick an explicit file or symbol from mention suggestions. | TrueForge chooses the searches, reads, edits, and checks. The panel shows current activity and clickable context rows derived from those calls. One request can reach implementation, tests, and docs. |
| Review | Inspect each hunk, accept or reject it, then choose **Apply accepted changes**. | One editor operation applies the approved subset. Show the applied files, any conflicts, and how to undo. Save before running external verification against disk. |
| Cancel | Press **Cancel** during streaming, tool work, or approval. | The UI responds immediately. Outstanding review controls become inactive. Unapplied proposals disappear. A late event cannot reopen the review or edit files. |
| Model failure | Repeat an inline edit with a broken primary connection. | The editor remains usable. Show a concise error, or switch automatically to the configured backup and present its diff for normal review. The Task C workspace remains clean. |

Use one panel for the prompt, stream, and context rows. Open the native diff only when there is something to review. Keep focus stable during token updates, use ordinary keyboard-accessible buttons, and give inline mode and agent mode the same review controls. Avoid a second chat interface, simulated streaming, or a separate dashboard.

## 3. Architecture and first integration proof

| Component | Owns |
|---|---|
| VS Code extension host | Commands, active selection, buffer versions, context ledger, staged proposals, native diff documents, final workspace edit, cancellation, and local MCP endpoint. |
| TrueForge client in the extension | Session creation, turn submission, streamed events, decisions for gated tool calls, session cancellation, and model-failure handling. Use the TypeScript SDK or equivalent official HTTP API. |
| Local TrueForge | Model selection and invocation, agent/tool loop, approval pauses, tool discovery, and the session trace shown to judges. The model decides which tools to call. |
| Workspace MCP tools | Bounded file and symbol discovery, reads, patch proposals, recording approved hunks, and execution of a configured verification command. |
| Demo fixtures | A disposable Flask checkout, sample application, expected outputs, and rehearsal checks. Keep all Flask-specific paths and expected solutions on this side of the boundary. |

Use a single editor MCP server bound to the loopback interface. Configure its URL once in TrueForge, e.g. `http://127.0.0.1:<configured-port>/mcp`. Keep the port configurable, dispose the listener on extension shutdown, and show a clear error if a second instance cannot bind. Restrict the endpoint to the intended local client using a connector header credential if exposing tools that can queue edits or run tests. Store private values outside tracked files.

**Live connector proof (owner 1, first session).**

1. Start with Node.js 22.14+ and the official local quickstart. For an endpoint registered with the literal host `127.0.0.1`, the following is the intended macOS/Linux launch configuration:

   ```sh
   OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@latest
   ```

   TrueForge's default local UI is at `http://localhost:8790`. Its upstream connector test explicitly expects HTTP 400 when registering a loopback URL under the default policy. The upstream environment example documents the allowlist. Keep the network policy enabled. After a working run, replace `latest` in the reproducible README with the version tested and lock the extension's SDK dependency. [Quickstart](https://trueforge.dev/quickstart) · [Connector test](https://github.com/truefoundry/trueforge/blob/e4fd3d4/packages/trueforge/tests/unit/apis/mcpServers.test.ts#L242-L264) · [Environment example](https://github.com/truefoundry/trueforge/blob/e4fd3d4/packages/trueforge/.env.example#L170-L174)
2. Register the editor connector, attach it to the agent, and configure a model in TrueForge. Put a distinctive line in a disposable workspace file. Give the model its path and ask it to read that line. Inspect the TrueForge session for the real tool call and matching response. Registration or tool listing alone does not prove the model can use it.
3. From VS Code, create a turn that proposes a small edit and requests the gated hunk tool. Deny once and allow once on separate calls. Check the corresponding decisions in the TrueForge session. Capture the working agent definition and record the server/SDK versions. This is the foundation for both editing modes. [SDK guide](https://trueforge.dev/api/use-agent) · [Agent spec](https://trueforge.dev/create-agent/overview)

**Suggested layout for the new ForgeLens repository.** Add modules as each milestone needs them. Keep editor UI, harness lifecycle, and workspace mutation independently testable.

```text
src/extension.ts            activation, commands, configuration, disposal
src/trueforge/              client, event handling, approvals, fallback
src/mcp/                    local transport and workspace tool handlers
src/context/                mentions, search, range selection, budget
src/review/                 proposal store, immutable previews, apply and undo
src/ui/                     agent panel and hunk actions
agent/forgelens.agent.json  actual agent definition or loadable template
examples/                   sample model/connector configuration without keys
demo/                       pinned fixture setup, sample app, smoke checks
README.md                   clean-clone setup, model switching, limitations
```

## 4. Agent, event, and tool contracts

Create a session referencing a saved agent or an inline spec from the checked-in definition. Resolve the selected model to a configured TrueForge model name at session creation. The extension must never send prompts directly to a provider. The agent instructions should describe how to search, inspect neighboring implementation/test/docs patterns, propose minimal edits, and verify applied results. Do not include the Flask solution or fixed filenames.

Use one connector entry with an explicit list of exposed tools. Gate the hunk-approval tool by its literal name. For selective loading, preload frequent search/read tools and leave an occasional tool such as `run_check` discoverable. Document which definitions were deferred and show real discovery in the session. This is the recommended B4 feature. The team's explorer proposal can wait until the mandatory tasks work reliably. [Deferred tool loading](https://trueforge.dev/key-features/deferred-tool-loading) · [Agent configuration](https://trueforge.dev/create-agent/overview)

| Tool | Inputs | Required result and behavior |
|---|---|---|
| `search_text` | Literal query, optional workspace-relative scope, result limit | Ranked path/line matches, bounded excerpts, truncation flag. Respect ignore rules and exclude generated/dependency folders. |
| `find_symbol` | Identifier and optional path hint | Candidate definitions with path, range, and evidence. Use VS Code's symbol provider where available. Fall back to bounded lexical search when no provider is installed. |
| `read_range` | Workspace-relative path, start/end line | Read the open document buffer when available. Return numbered lines, a source snapshot ID, and whether the range was shortened. UI and tool contracts use 1-based line numbers. Convert once at the VS Code boundary. |
| `propose_edit` | Source snapshot ID, exact range or unique old-text anchor, replacement text | Validate the proposal against the snapshot. Compute independently reviewable hunks, assign opaque IDs, and return them. Store edits in memory. Reject stale, ambiguous, overlapping, or out-of-workspace targets with a recoverable explanation. |
| `approve_hunk` | Opaque hunk ID | A TrueForge-gated call for exactly one visible hunk. On approval, mark this hunk eligible for the final batch. A denial excludes it. This is the team's proposed `apply_hunk` split into approval and a later atomic workspace edit so cancellation cannot leave a partial patch. |
| `run_check` | A configured check ID and validated arguments | Run a real command selected by the agent. The demo profile exposes the Flask CLI test suite after accepted edits are saved. Show command, working directory, bounded stdout/stderr, exit code, and cancellation. Use the chosen Python environment and trusted workspace. Executable and permitted arguments come from the profile. |

Bind every tool result, proposal and approval to the originating run and workspace. A server-side run token or verified session mapping must survive overlapping callbacks during cancellation or fallback. Never accept a model-supplied path or hunk ID as proof of ownership. Resolve paths within the workspace and reject traversal outside it. Keep edits, temporary previews, and logs free of credentials.

**Stream handling.** Keep session ID, turn ID, last event ID, and active run identity. Render real `model.message.delta` chunks. Associate `tool.approval_required` calls with their source message, arguments, thread, and hunk ID. After a pause, subscribe from the last event, send one `user.tool_approval` per pending call on that turn, then consume the resumed stream. A dropped stream can reconnect to the existing turn. Replaying an event must never apply a change twice. Check the terminal `turn.done` state for success, error, or cancellation. Use the field casing of the installed SDK. [SDK streaming, approvals, and reconnection](https://trueforge.dev/api/use-agent)

## 5. Retrieval and the visible context budget

**Budget choice:** 6,000 estimated tokens of retrieved source per run. This is a team design choice. Label it **estimated source tokens**. It excludes system instructions, tool schemas, model responses, and protocol overhead. A deterministic estimate such as one unit per four UTF-8 bytes, rounded up, is adequate if the write-up discloses it. If the same source text is sent twice, charge both deliveries. Prefer returning a reference to an earlier range when no new text is needed.

1. Parse explicit `@file` and `@symbol` selections into real paths and ranges. Offer a picker for ambiguous symbols. Include the inline selection or explicit mentioned excerpts first and charge their text. For a mention too large to fit, select a relevant bounded excerpt and label the omission.
2. Give the agent tools to search for likely concepts, follow an identifier to its registration or call sites, and inspect adjacent tests/docs. Rank exact definitions and matching identifiers above plain text. Return short snippets with line references and read more only when needed. The algorithm must work with arbitrary repositories.
3. Before emitting search snippets or a read result, cap the payload to the remaining budget. Preserve complete lines when possible. At exhaustion, return a small structured result describing the limit. Prevent parallel tool calls from spending the same remaining budget twice.
4. Add a row after each retrieval containing path/range, actual query or symbol, selection reason, estimated cost, and cumulative total. Distinguish searched candidates from excerpts actually sent to the model. Show a truthful exclusion if a result is truncated, deduplicated, or exceeds the limit. Clicking a row opens the matching source.

**Acceptance:** Task B starts from a fresh session, an empty prompt composer, and no selected file context. The agent independently discovers three or more relevant files. A judge can see one real implementation match, one test pattern, and one docs match and follow each back to source. A test with two similar filenames and a forced-small budget demonstrates ranking and truncation without relying on the Flask fixture.

## 6. Review, cancellation, and recovery

**Hunk lifecycle.** Store the immutable base text/version and the proposed replacement. Render native diffs using virtual before/after documents. When the model requests approval for a hunk, the visible Accept/Reject control answers the corresponding gated call. Keep the review panel usable across repeated approval pauses. Treat a rejected hunk as final for that proposal. The model must not silently submit it again.

**Batch application.** After the proposal set is complete and approval responses are resolved, show the approved files and hunk count. Revalidate each target's current buffer against its captured base. If any target changed, apply none and offer re-read/regeneration that preserves the user's edits. Construct one text-only `WorkspaceEdit` over existing files using the original ranges. Check the apply result before showing success. Use normal VS Code undo, verify it across files, and make saving explicit. For a follow-up check, resume the TrueForge conversation after Apply/Save and tell it which files were actually applied or rejected. An early check against the unchanged tree must be labeled as a baseline, never as validation of a proposal. [VS Code workspace API](https://code.visualstudio.com/api/references/vscode-api#WorkspaceEdit)

**Cancellation.** Immediately mark the run inactive, invalidate its pending hunk IDs, stop accepting UI decisions, abort local tool work and cancel the TrueForge session. Continue draining the terminal event for cleanup. Guard the final apply action against a cancelled run. Serialize Apply and Cancel so one complete user action wins. After a completed Apply, user-approved changes remain undoable. After a pre-Apply cancellation, all original disk and buffer contents remain intact, including unrelated user edits. The SDK can wait for an in-flight MCP call to finish, so promptly terminate child checks as well as dropping late UI results. [TrueForge cancellation](https://trueforge.dev/api/use-agent)

**Model recovery.** Classify cancellation, transport loss, model failure, and tool errors separately. Reconnect to a live turn after a dropped client stream. A user cancellation must never trigger fallback. For an invalid key on the primary, try the independently configured backup once if available. For transient provider failures, account for the harness's existing retry/backoff behavior before adding any client retry. Start a fresh backup session with the same editor capabilities and original instruction/selection, invalidate primary proposals, and announce the switch. Limit automatic resubmission to runs without applied edits or executed commands with side effects. If both models fail, show a concise actionable error and finish the run. Test the failure using a disposable model configuration. [Model HTTP retry configuration](https://github.com/truefoundry/trueforge/blob/e4fd3d4/packages/trueforge/src/config.ts#L910-L928)

**Scoring trade-off.** A clear model error with a clean workspace satisfies the fixed Task C demonstration. The rubric awards 4/10 for that behavior, 7/10 for demonstrated retry with backoff followed by a clear error and clean workspace, and 10/10 for automatic fallback with an unchanged workspace. Ship and demonstrate the highest level actually achieved. [Rubric, p. 8](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf)

## 7. Fixed tasks and executable acceptance checks

Use the exact prompts below in the recording. Set up separate clean checkouts or worktrees for A, B, and C before filming. Use the fixture outside the extension repository. Verify `git rev-parse --short=8 HEAD` prints `22d92470`, and record the imported Flask path. Use the same activated Python environment for the terminal, the extension's check profile, and the recording. The checkout must have Flask's development/test dependencies. In a disposable venv, install the checkout in editable mode and install its test requirements. Before any generated edits, run `pytest tests/test_cli.py -q` and record its result. [Pinned Flask release](https://github.com/pallets/flask/tree/3.1.3) · [Official task text, pp. 4–5](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf)

For a fresh macOS/Linux fixture with `uv`, run this inside each pinned checkout. The `tests` group and lockfile are present in the release. Activating that checkout's venv also selects its editable Flask install when the terminal calls `flask`. [Pinned dependency groups](https://github.com/pallets/flask/blob/22d92470/pyproject.toml#L37-L65)

```sh
uv sync --frozen --group tests
source .venv/bin/activate
git rev-parse --short=8 HEAD
python -c "import flask; print(flask.__file__)"
pytest tests/test_cli.py -q
git status --short
```

### Task A — inline edit

Open `src/flask/helpers.py`, select the entire `get_debug_flag` function, invoke the keybinding, and enter exactly:

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Review the diff, accept it, apply, save, then run:

```sh
FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
```

Show **False** before demonstrating undo. The unmodified checkout returns **True** for `off`. Rehearse with mixed case (`OFF`, `N`), the existing false values (`0`, `false`, `no`, empty and unset), and an ordinary true value such as `1`. Inspect the docstring for accuracy. Undo should restore the original function. Use a shell supporting the command as written. [Original implementation](https://github.com/pallets/flask/blob/22d92470/src/flask/helpers.py#L25-L30)

### Task B — autonomous multi-file change

Start a new agent session in the pinned checkout with no mentions, selected range, code attachments, or filenames added by the extension. Enter exactly:

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

Show discovery, review and apply the hunks, save, and briefly open the actual TrueForge session showing its turns and tool calls. Required on screen: the diff reaches at least three files, the CLI tests pass, and running the new command prints masked JSON. Verify help as well.

```sh
python -c "import flask; print(flask.__file__)"
git diff --stat
pytest tests/test_cli.py -q
flask --help
```

**Sample application.** Keep this file outside the judged checkout so it does not supply an extra changed file. Substitute its actual absolute path for the shell variable below.

```python
from flask import Flask

app = Flask(__name__)
app.config.update(
    DEMO_REGION="west",
    APP_SECRET="fake-secret",
    DATABASE_PASSWORD="fake-password",
    SERVICE_TOKEN="demo-only",
    API_KEY="fake-key",
)
```

```sh
export FORGELENS_DEMO_APP=/absolute/path/to/demo_app.py
flask --app "${FORGELENS_DEMO_APP}:app" config
```

**Acceptance oracle for the verifier:** capture exit code and stdout separately. Require exit 0, JSON parse success, `DEMO_REGION == "west"`, and `"***"` for all four sample sensitive values. Confirm the original four fake values occur nowhere in stdout. Keep Flask defaults intact. In the pinned baseline, both standard JSON encoding and Flask's JSON provider raise a `TypeError` on the default `PERMANENT_SESSION_LIFETIME` (a `timedelta`). Require the generated command to handle this real default and document its representation. A generated test should fail for the missing command on base, then pass with the implementation. Confirm `flask --help` lists `config`. Ensure the agent actually added coverage and docs. The research run passed **58 existing CLI tests** before any change. That count is baseline evidence, not a target for the finished suite. [Default Flask config](https://github.com/pallets/flask/blob/22d92470/src/flask/app.py#L178-L190) · [Neighboring command](https://github.com/pallets/flask/blob/22d92470/src/flask/cli.py#L590-L598) · [CLI tests](https://github.com/pallets/flask/blob/22d92470/tests/test_cli.py#L446-L475)

### Task C — model failure

Use the clean Task C checkout. In TrueForge, select a primary provider with a deliberately invalid key or unreachable endpoint. Show the configured failure condition without exposing a credential. Repeat **the exact Task A selection and instruction**. During failure, demonstrate editor responsiveness. Show the clear error or automatic backup switch. If the backup produces a diff, leave it unaccepted. Run `git status --short` before and after and show that both outputs are empty; keep the terminal prompt visible so empty output is legible. Also inspect that the real editor buffer stayed unchanged. A successful fallback must require zero manual model selection after the prompt.

## 8. Regression and integration checks

Run the repository's build, typecheck, lint and applicable tests from a clean clone. Add focused regression tests alongside each behavior. Use controlled event sequences for race conditions, real VS Code extension-host tests for editor semantics, and real model sessions for competition claims.

| Case | Pass condition |
|---|---|
| Two separated hunks in one file; accept one, reject one | Only accepted text appears after Apply. Undo restores the pre-apply buffer. |
| Three files with independent hunks | Preview changes no real document. One Apply changes only approved hunks. Undo restores all affected text. |
| User changes one buffer during review | Conflict names the file; no approved file in that batch changes. Manual edit survives. |
| Cancel during streaming, at approval, and during a running check | UI returns control immediately; no new diff or write appears later. An unrelated dirty buffer survives. |
| Duplicate approval, stale hunk ID, late primary result after fallback | No duplicate apply, resurrected proposal, or cross-run write. |
| Multiple same-name symbols, ignored directories, oversized and overlapping ranges | Ambiguity is visible, matches stay scoped, and the source budget never exceeds its cap. |
| Primary auth failure, transient failure, backup failure, user cancellation | Correct event classification, bounded attempts, legible final state, no write or replay of side effects. |
| New session with a second configured model | Repeat A without code changes. Record the actual model and outcome. |
| Fresh machine or second clean environment | Follow README only, launch TrueForge and the extension, load the saved agent, complete a real tool call. |

For critical guards (stale snapshot, cancellation, budget, apply-once), temporarily defeat the guard in an isolated test run. Confirm its targeted test fails for the expected reason and restore the intended code. Compare observed file changes, subprocess exit status, and visible UI text. A mocked transport cannot establish the live connector, actual model behavior, or native undo.

## 9. Ownership and cut order

| Owner | First deliverable | Integrated finish |
|---|---|---|
| 1 · Harness | Live editor read through TrueForge; allow and deny a real gated call. Provide an event sample to owner 2. | Streaming/cancel and a readable provider failure. Add automatic fallback using independent credentials after Task B is working. |
| 2 · Editor | Inline selection through immutable diff and native apply/undo. Agree on stable hunk IDs with owners 1 and 3. | Same review flow across files, conflict detection, clean cancellation, and legible keyboard-accessible controls. |
| 3 · Retrieval and tools | Search, symbol lookup, bounded reads, proposal and check tools. Agree on the context-row schema with owner 2. | Task B discovers source, tests, and docs. Show budget and reasons from the real run. Demonstrate selective tool discovery. |
| 4 · Verification and submission | Prepare three pinned fixtures; prove imports, baseline tests, and the sample-app JSON oracle. | Run acceptance on the integrated build; clean-clone rehearsal, video, actual scorecard, PDF, and signed-out link checks. |

**17 Nov:** real gated tool call and Task A end to end. **18 Nov:** record a rough Task B run that passes its CLI and masked-JSON checks. If B fails, identify the first failed step in the trace and fix that dependency. **19 Nov:** freeze new features, run C, film a cancellation and undo, test the second model if available, and rehearse under four minutes. **20 Nov:** record final evidence, write the PDF against the recording, verify all links, and submit by the internal target.

Cut candidate-tree testing and an explorer first. Preserve eligibility, all three fixed tasks, visible context selection, per-hunk review, cancellation/undo, and submission time. Automatic fallback is worth three additional B3 points over a demonstrated retry/backoff + clean error. Selective loading can add B4 depth if it serves a real purpose and appears in the session.

## 10. Packaging, scoring evidence, and handoff

**Video.** Record A → B → C with the editor visible. Suggested allocation: A 0:00–0:50, B 0:50–3:05, C 3:05–3:55. Budget a short, separate cancellation demonstration within the A segment after its verification. Keep each official prompt-to-diff sequence continuous. The brief permits removing model waiting time and prohibits a cut between the instruction and diff. The simplest compliant edit is a continuous prompt-to-diff take. Show B's TrueForge session and verify each task before advancing. Use the final edit's timestamps in the PDF.

| Scorecard row | Points | Evidence to capture |
|---|---:|---|
| A1 Inline edit | 10 | Keybinding, selected function, rendered diff, per-hunk accept/reject controls. |
| A2 Agent mode | 10 | Single filename-free Task B prompt, discovery and accepted changes across at least three files. |
| A3 Streaming and cancellation | 10 | Real streamed text, mid-run Cancel, responsive editor, unchanged workspace. |
| B1 Context assembly | 15 | Task B shows actual matches, reasons, bounded excerpts, and budget. PDF explains selection. |
| B2 Diff safety | 10 | Visible per-hunk decisions and working undo on screen after a change was applied. |
| B3 Resilience | 10 | Broken primary and clean status. Describe the failure behavior actually demonstrated. |
| B4 TrueForge integration | 10 | Session with MCP tools, real approval, and meaningful use of a context feature. Explain the chosen feature. |
| C1 Video | 10 | Three legible, verified tasks in order, total runtime ≤4 minutes. |
| C2 Write-up | 15 | Architecture, design trade-offs, model details, accurate timestamped scorecard, honest limitations. |

**PDF.** Use these eight headings in order: **Team**, **Starting point**, **Architecture on TrueForge**, **How context is selected**, **Model setup**, **Scorecard**, **Tools used**, **Known limitations and what you would do with another month**. Include members and affiliations, GitHub handles, all models/hosting/approximate cost, model-switch instructions, and AI coding tools used. For evidence present only in the PDF, identify the relevant section honestly. Preserve actual video timestamps and one evidence claim per row.

**Repository.** Include working clean-clone steps, tested versions, how to launch the extension in VS Code, connector registration and agent-loading instructions, model setup and switching, the actual agent definition, example config without secrets, tests, and an open-source license. If forked, include the upstream URL, exact base commit, attribution, preserved license, and changes. Keep demo fixtures distinguishable from extension code.

**Release check.** Open the repo, PDF and video signed out. Check the video duration and playback resolution, PDF page count, all eight headings, and commands from the final commit. The team submits the three links through the portal. Retain the submitted commit identifier and submission confirmation. [Submission and eligibility, pp. 5–7](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf)

**Implementer's final report:** give the built commit, commands actually run, passing/failing checks, live session evidence for A/B/C, features that still require manual verification, and inputs the team must supply. Keep the research baseline separate from evidence produced by the built extension.
