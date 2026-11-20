# ForgeLens

ForgeLens is a desktop VS Code extension that uses a **local TrueForge** instance as its agent harness. You select code (inline edit) or describe a repository-level task (agent mode). TrueForge runs the model and chooses which of ForgeLens's workspace tools to call. ForgeLens shows every proposed change as a per-hunk diff that you accept or reject, then applies only the accepted hunks in one undoable editor operation.

The distinctive feature is a visible account of **which source ranges the agent used, how it found them, and what fit in its context budget** (6,000 estimated source tokens per run by default). Every retrieval adds a clickable row to the ForgeLens panel.

- The extension never talks to a model provider. It sends prompts only to local TrueForge (`127.0.0.1`). Provider keys live in TrueForge settings.
- The editor tools reach TrueForge through one MCP server that ForgeLens binds to `127.0.0.1` and protects with a bearer token stored in VS Code Secret Storage.
- Supported scope: one trusted Git workspace, one active run, existing UTF-8 text files.

## Starting point

Built **from scratch** in an empty `forgelens` repository. It is not a fork, so there is no upstream. Licensed under MIT (see `LICENSE`). Demo material in `demo/` and `fixtures/` is separate from extension code in `src/`. The Flask demo workspace is a separate checkout outside this repository.

## Tested versions

| Component | Version |
| --- | --- |
| TrueForge runtime | `@truefoundry/trueforge@0.185.1` |
| TrueForge SDK (locked in `package-lock.json`) | `@truefoundry/trueforge-sdk@0.185.0` |
| MCP SDK / TypeScript (locked) | 1.32.2 / 5.9.3 |
| Node.js | 24.19.0 (harness proof machine), 24.22.1 (docs machine); `package.json` requires `>=22.14` |
| VS Code | 1.146.0 (the extension declares `^1.98.0`) |
| uv | 0.13.7 |
| Python | 3.12.10 on the docs machine; Flask 3.1.3 declares `requires-python >=3.9` |
| Ollama (harness proof only) | 0.34.0 |

## Requirements

- macOS, with desktop VS Code and its `code` shell command (Command Palette → *Shell Command: Install 'code' command in PATH*). Without `code`, open this repository in VS Code and press F5 with the **Launch ForgeLens** configuration.
- Node.js 22.14 or later (includes `npx`).
- Python and [uv](https://docs.astral.sh/uv/), for the pinned Flask demo checkouts.
- Git.
- A tool-capable model. Primary: Google Gemini (free tier). Backup: Ollama with `qwen3:8b` (about 5 GB, roughly 16 GB RAM). See step 4 below.

## Setup from a clean clone

### 1. Clone and build

```sh
git clone https://github.com/vianmangal/ForgeLens.git
cd ForgeLens
npm ci
npm run build
```

`npm run build` writes `build/extension.cjs`, which the extension loads. Rebuild after changing source.

### 2. Prepare the pinned Flask checkouts

Tasks A, B and C each need their own clean checkout of `pallets/flask` 3.1.3 at commit `22d92470`, kept **outside** this repository. The checkout, `uv sync` and baseline test below were run on macOS from a fresh clone: `pytest tests/test_cli.py -q` reported `58 passed` and `git status --short` was empty before any edits.

```sh
mkdir -p ~/forgelens-demo && cd ~/forgelens-demo
for name in flask-a flask-b flask-c; do
  git clone https://github.com/pallets/flask.git "$name"
  (cd "$name" && git checkout 22d92470 && uv sync --frozen --group tests)
done
cd flask-a
source .venv/bin/activate
git rev-parse --short=8 HEAD            # 22d92470
python -c "import flask; print(flask.__file__)"
pytest tests/test_cli.py -q             # 58 passed
git status --short                      # empty
```

Repeat the `source .venv/bin/activate` block in `flask-b` and `flask-c` whenever you open a terminal there. Flask's own `.gitignore` excludes `.vscode/`, so the workspace settings file in step 6 does not dirty `git status`.

The `demo/` scripts check results; they do not create checkouts:

| File | Purpose |
| --- | --- |
| `demo/check_task_a.sh` | Runs `get_debug_flag()` for `off`, `OFF`, `n`, `N`, `0`, `false`, `no`, empty, unset (all must print `False`) and `1` (must print `True`). Needs the checkout's venv active. |
| `demo/check_task_b.sh` | Needs `FORGELENS_DEMO_APP`. Runs `flask --app "$FORGELENS_DEMO_APP:app" config`, requires exit 0, valid JSON, `DEMO_REGION == "west"`, `"***"` for `APP_SECRET`, `DATABASE_PASSWORD`, `SERVICE_TOKEN`, `API_KEY`, none of the four fake values in output, `PERMANENT_SESSION_LIFETIME` present, `config` listed by `flask --help`, then `pytest tests/test_cli.py -q`. Run it from inside the Flask checkout. |
| `demo/demo_app.py` | The sample Flask app used by Task B. It stays outside the judged checkout. |

On the unmodified checkout, `demo/check_task_a.sh` fails the `off`, `OFF`, `n` and `N` cases (it prints `True`). That is the expected baseline before Task A.

### 3. Start TrueForge locally

TrueForge refuses loopback connector URLs unless they are allowlisted. Leave this terminal running.

```sh
HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx --yes @truefoundry/trueforge@0.185.1
```

The UI is at `http://localhost:8790`. ForgeLens expects TrueForge on `127.0.0.1:8790` (setting `forgelens.trueforgePort`). Sessions are kept in TrueForge's database, so you can inspect traces under **Sessions**.

### 4. Configure the primary and backup models

Add the two models as **separate providers** in TrueForge (Settings → Model Providers). Keys are typed only into TrueForge. Nothing in this repository contains a key. A placeholder list is in [`examples/models.example.md`](examples/models.example.md).

| Role | Provider in TrueForge | Model |
| --- | --- | --- |
| Primary | Built-in `google-gemini`, API key from Google AI Studio | `gemini-3-1-flash-lite` (free tier) |
| Backup | Custom provider `ollama`, base URL `http://localhost:11434/v1`, blank API key | `qwen3:8b`, TrueForge name `qwen3-8b`, context length `32768`, max output tokens `8192`, reasoning effort ticked and set to `none` |

For the backup, install Ollama, run `ollama pull qwen3:8b`, and keep Ollama running. Notes from the team's testing are in [`docs/models-and-resilience.md`](docs/models-and-resilience.md). The model name ForgeLens needs is the complete `provider/model` string shown in TrueForge after you save each provider.

Both models passed TrueForge's built-in tool-call test on 17 Nov. For the results with the ForgeLens connector, see the [model checks on 20 November](docs/models-and-resilience.md#forgelens-model-checks-on-20-november).

### 5. Launch the extension and register the connector

Open the Flask Task A checkout in an Extension Development Host:

```sh
cd ForgeLens
code --new-window --extensionDevelopmentPath="$PWD" ~/forgelens-demo/flask-a
```

Trust the folder when asked. Alternatively, open this repository in VS Code, press F5 with **Launch ForgeLens**, then open the checkout in the new window. The extension activates on startup and starts the MCP endpoint on port 8791. If the port is busy it shows an error.

Register the connector in TrueForge:

1. In the Development Host, run **ForgeLens: Copy MCP Connector Token** (`forgelens.copyMcpToken`).
2. In TrueForge, open **Settings → Connectors → Add MCP Server**. Choose a remote HTTP server, name it exactly `forgelens`, and use URL `http://127.0.0.1:8791/mcp` (or your `forgelens.mcpPort`).
3. Set the header `Authorization` to `Bearer <the copied token>`.

The extension creates sessions from `agent/forgelens.agent.json` with the model name taken from your settings, so no manual agent attachment is required. That manifest exposes six tools (`search_text`, `find_symbol`, `read_range`, `propose_edit`, `approve_hunk`, `run_check`). It preloads the first five and leaves `run_check` for TrueForge's deferred tool discovery. Only `approve_hunk` and `run_check` require approval. To also save a named `forgelens` agent in TrueForge for inspection, run once after the connector exists:

```sh
node scripts/register-agent.mjs <provider>/<model>
```

### 6. ForgeLens settings

Put these in each Flask checkout's `.vscode/settings.json` (or in your user settings). Replace the placeholders.

```json
{
  "forgelens.primaryModel": "<provider>/<model>",
  "forgelens.backupModel": "<provider>/<model>",
  "forgelens.pythonPath": "/absolute/path/to/forgelens-demo/flask-a/.venv/bin/python",
  "forgelens.checkProfiles": [
    { "id": "cli-tests", "args": ["-m", "pytest", "tests/test_cli.py", "-q"] }
  ]
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `forgelens.primaryModel` | empty | Required. Complete `provider/model` name configured in TrueForge. |
| `forgelens.backupModel` | empty | Used once when the primary fails with an auth, server or network error. Blank turns fallback off. |
| `forgelens.pythonPath` | `python` | Executable used by `run_check`. Use the checkout's venv Python. |
| `forgelens.checkProfiles` | `pytest` (`-m pytest -q`) | Allowlist of Python check profiles. Set an empty list to disable checks. |
| `forgelens.mcpPort` | 8791 | Loopback port of the ForgeLens MCP server. Read when the extension starts. |
| `forgelens.contextBudget` | 6000 | Estimated source tokens shared by retrieval tools per run. |
| `forgelens.trueforgePort` | 8790 | Port of local TrueForge on `127.0.0.1`. |
| `forgelens.proofPort` | 8792 | Port of the Harness proof connector. |
| `forgelens.review.autoOpenDiff` | `true` | Open the diff when the first change for a file arrives. |

## Commands

| Command | ID | Notes |
| --- | --- | --- |
| ForgeLens: Edit Selection | `forgelens.editSelection` | `Cmd+Alt+E` on macOS (`Ctrl+Alt+E` elsewhere) while an editor has focus |
| ForgeLens: Open Agent Panel | `forgelens.openPanel` | Prompt, streamed reply, context rows |
| ForgeLens: Cancel Run | `forgelens.cancel` | Same as the panel's **Cancel run** button |
| ForgeLens: Cancel Review | `forgelens.cancelRun` | Button in the **ForgeLens Review** Explorer view |
| ForgeLens: Apply Accepted Changes to Files | `forgelens.applyAccepted` | Writes all accepted hunks in one `WorkspaceEdit` |
| ForgeLens: Undo Last Apply | `forgelens.undoLastApply` | `Cmd+Z` also works |
| ForgeLens: Copy MCP Connector Token | `forgelens.copyMcpToken` | See step 5 |

Accept and Reject appear as CodeLens above each change and as buttons in **ForgeLens Review** (Explorer sidebar). Details are in [`docs/editor-review.md`](docs/editor-review.md).

## Task A: inline edit

1. Open `~/forgelens-demo/flask-a` in the Development Host. Open `src/flask/helpers.py` and select the entire `get_debug_flag` function.
2. Press `Cmd+Alt+E` and enter exactly:

   > Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
3. Watch the progress notification stream. When the diff opens, accept the change (CodeLens or **ForgeLens Review**). Apply the accepted change, then save the file (`Cmd+S`).
4. In a terminal in the checkout, with its venv active:

   ```sh
   FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"   # False
   bash /path/to/ForgeLens/demo/check_task_a.sh
   git diff --stat
   ```
5. Undo with `Cmd+Z` or **ForgeLens: Undo Last Apply**. The original function returns.

## Task B: autonomous multi-file change

1. Close the Development Host and reopen it on `~/forgelens-demo/flask-b` (set `forgelens.pythonPath` for that checkout). Do not select any code or open any file for the run.
2. Run **ForgeLens: Open Agent Panel**, enter exactly the text below, and select **Run task**:

   > Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
3. Watch **Retrieved context** in the panel. Each row shows the tool, query, signal, estimated cost, cumulative total and any exclusion. Clicking a row opens the cited range.
4. Review each hunk in **ForgeLens Review**, accept the wanted ones, apply, and save all files. Open `http://localhost:8790` → **Sessions** to show the turns and tool calls.
5. Verify, from inside the checkout with its venv active:

   ```sh
   export FORGELENS_DEMO_APP=/absolute/path/to/ForgeLens/demo/demo_app.py
   python -c "import flask; print(flask.__file__)"
   git diff --stat
   pytest tests/test_cli.py -q
   flask --help
   flask --app "${FORGELENS_DEMO_APP}:app" config
   bash /absolute/path/to/ForgeLens/demo/check_task_b.sh
   ```

`examples/trueforge-connector.json` and `examples/vscode-settings.json` show the connector and settings without credentials. With no `forgelens.checkProfiles` setting, `run_check` offers one profile, `pytest`, which runs `forgelens.pythonPath -m pytest -q` in the workspace root. The tool description lists the configured profile IDs. `demo/vscode-settings.json` replaces the default with a Flask CLI test profile.

The team manifest explicitly exposes six MCP tools. Search, symbol lookup, range reads, edit proposals and hunk approvals are preloaded. The model can discover `run_check` when needed. Only `approve_hunk` requires a human decision. The proof uses its own connector and three bounded tools, so it can run before Person 3 ships the team connector. [TrueForge SDK guide](https://trueforge.dev/api/use-agent) · [Deferred tool loading](https://trueforge.dev/key-features/deferred-tool-loading)

The agent panel groups proposed hunks by file. Open a diff or accept and reject individual hunks there. After Apply, choose **Save and verify** to send the applied files and rejected ranges back to the original TrueForge session. The agent can discover and run a configured check. Inspect its command, exit code and output. The Task B acceptance script additionally checks the CLI help and masked JSON.

## Task C: model failure

1. Reopen the Development Host on `~/forgelens-demo/flask-c`. In TrueForge, make the primary provider fail without showing a real key: save a deliberately invalid key in the primary provider, or add a separate provider with an invalid key and point `forgelens.primaryModel` at it.
2. Set `forgelens.backupModel` to the Ollama model for the automatic-fallback demonstration. Leave it blank to demonstrate a clear error only.
3. In a terminal in `flask-c`, run `git status --short`. It must print nothing.
4. Repeat the exact Task A selection and instruction in `src/flask/helpers.py`.
5. Observe: the editor stays responsive, and either the panel/notification shows a concise error or ForgeLens announces `Primary model failed → using backup <model>` and presents the backup's diff. Leave any backup diff unaccepted.
6. Run `git status --short` again. It must still print nothing. Confirm the open buffer is unchanged.

Failure classification (`src/trueforge/harness.ts`): HTTP 401/403 and messages like "API key not valid" count as `auth`, 429/5xx as `server`, timeouts and connection errors as `network`. `cancelled` never falls back. See [`docs/models-and-resilience.md`](docs/models-and-resilience.md).

## Run the tests

```sh
npm run lint          # check TypeScript and JavaScript
npm run compile       # typecheck
npm test              # compile, then node --test test/*.test.cjs
npm run test:host     # build, then an isolated VS Code extension-host suite (macOS)
```

The host suite launches VS Code with a disposable workspace and profile. Set `VSCODE_EXECUTABLE_PATH` to use an installed VS Code executable.

## Harness proof

This proves the TrueForge integration with an isolated three-tool connector and a 1.4 GB local proof model before the team's real tools were attached. It uses ports 8790 (TrueForge), 8792 (proof connector) and 11436 (Ollama). It is independent of the competition models.

The unit tests need no TrueForge server, model or VS Code window:

- **Harness** (`test/harness.test.cjs`):
  - streamed deltas, and approval correlation, including approvals reached through deferred `call_tool` discovery
  - batched decisions, plus interrupted and replayed streams
  - the one-time missing-approval follow-up
  - cancellation while streaming and while paused
  - MCP session ownership, and the installed SDK's wire format
- **Fallback** (`test/fallback.test.cjs`):
  - failure classification
  - one switch to the backup after an auth, server or network failure, and no switch on cancel or tool errors
  - no replay once `run_check` may have run
  - late primary events ignored, and the selection re-charged to the backup run
- **MCP connector and tools** (`test/mcp-session.test.cjs`, `test/mcp-tools.test.cjs`):
  - bearer authentication and per-session run binding
  - tool contracts that match the agent manifest
  - `read_range` shortening, and snapshot ownership and staleness checks
  - `approve_hunk` decision reporting
  - `run_check` profiles, command reporting and cancellation
- **Retrieval and budget** (`test/retrieval-context.test.cjs`, `test/context-budget.test.cjs`):
  - `.gitignore` handling, definition-first ranking with a forced-small budget, and symbol scoping and the picker
  - inline-selection charging
  - the 4-bytes-per-token estimate, and the cap under concurrent calls
- **Review** (`test/review-*.test.cjs`, `test/selection-fallback.test.cjs`):
  - hunk construction, overlap and anchor rules, and rejected-hunk finality
  - atomic Apply, conflict detection and undo bookkeeping
  - Edit Selection following a backup run
- **Configuration** (`test/agent-manifest.test.cjs`, `test/examples.test.cjs`, `test/proof.test.cjs`):
  - agent instructions and deferred tool loading
  - example files without credentials
  - the proof fixture

`npm run test:host` runs eight cases in a real VS Code extension host; [docs/editor-review.md](docs/editor-review.md#extension-host-checks) lists them. They cover per-hunk Apply and native undo across one and three files, conflict refusal, cancellation, version-only conflicts, fallback invalidation and bulk decisions. The TrueForge event source in those cases is a local fixture. The last run passed 8 of 8 on VS Code 1.147.0.

The live results below used the installed extension, TrueForge and Ollama with the isolated proof connector.

These still need a real model:

- the team connector end to end
- Tasks A, B and C
- a second model
- a clean-machine setup

[docs/spec-audit.md](docs/spec-audit.md) tracks each requirement and its evidence.

In separate terminals:

```sh
OLLAMA_HOST=127.0.0.1:11436 OLLAMA_MODELS="$PWD/.local/models" OLLAMA_NO_CLOUD=1 ollama serve
```

```sh
OLLAMA_HOST=127.0.0.1:11436 ollama pull qwen3:1.7b
HOST=127.0.0.1 SQLITE_PATH="$PWD/.local/proof.sqlite" OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx --yes @truefoundry/trueforge@0.185.1
```

```sh
node scripts/configure-proof.mjs
code --new-window --extensionDevelopmentPath="$PWD" "$PWD/.local/proof-workspace"
```

In the Development Host run **ForgeLens: Start Proof Connector**, then **ForgeLens: Run Harness Proof**. Compare the old and new text, click **Reject**, repeat and click **Accept**, and cancel a third run at the approval. Inspect each run under **Sessions** in TrueForge. The automated version drives the same commands in an isolated test host:

```sh
code --wait --user-data-dir="$PWD/.local/test-profile" --extensions-dir="$PWD/.local/test-extensions" --disable-extensions --disable-workspace-trust --extensionDevelopmentPath="$PWD" --extensionTestsPath="$PWD/integration/live-proof.cjs" "$PWD/.local/proof-workspace"
```

Results recorded on 17 Nov 2026 with the local Qwen3 1.7B proof model: a rejected edit received the recorded denial; an approval delivered **300.046 seconds** after the request let the turn finish; a cancel at the approval and a cancel after the first 3 streamed characters each recorded a cancelled turn with no later callbacks. `examples/approval-trace.json` holds the rejection trace. Session links in TrueForge resolve only on the machine that holds the proof database.

**Integration API.** The activated extension exports `startRun`, `approve`, `reject`, `cancel`, `registerProposed`, `onRunFailed` and `review` (see `src/extension.ts`). Shared 1-based contracts live in `src/shared/types.ts`.

## Known limitations

See section 8 of [`docs/writeup.md`](docs/writeup.md).

## Repository layout

```text
src/extension.ts      activation, commands, configuration, disposal
src/trueforge/        session client, event handling, approvals, fallback
src/mcp/              loopback MCP server and the six workspace tools
src/context/          mentions, search, symbols, context budget
src/review/           proposal store, native diff, apply, undo
src/ui/, media/       agent panel
src/proof/            harness proof connector
agent/                forgelens.agent.json
scripts/              configure-proof.mjs, register-agent.mjs
demo/, fixtures/      Flask checks, sample app, proof file
examples/             model configuration without keys, approval trace
docs/                 editor-review.md, models-and-resilience.md, writeup.md
```
