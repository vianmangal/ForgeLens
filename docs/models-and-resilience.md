# Models and resilience notes

Owner: Person 5 (Models and resilience). Last updated: 20 Nov 2026.

## Model setup in TrueForge

| Role | Provider entry | Model ID | Name in TrueForge | Where it runs | Cost |
| --- | --- | --- | --- | --- | --- |
| Primary | google-gemini (built-in) | gemini-3.1-flash-lite | gemini-3-1-flash-lite | Google cloud, free tier | Free |
| Backup | ollama (custom provider) | qwen3:8b | qwen3-8b | Locally via Ollama | Free |

Both passed a tool-call test using TrueForge's built-in connector on 17 Nov.
Keys are entered in TrueForge's Settings, never in this repo.

### Setting up the backup (each person who needs it)

1. Install Ollama from ollama.com and open it (choose "use Ollama locally").
2. Run `ollama pull qwen3:8b` (about 5 GB; needs roughly 16 GB RAM).
3. Start TrueForge with localhost allowed:
   `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest`
4. In TrueForge: Settings → Models → Add Custom Provider
   - Name: `ollama`
   - Base URL: `http://localhost:11434/v1`
   - API key: blank
   - Model ID: `qwen3:8b`, Model name: `qwen3-8b`
   - Context length: `32768`, Max output tokens: `8192`
   - Reasoning effort: ticked, set to `none`
5. Ollama must be running (llama icon in the menu bar) whenever the backup is used.

## ForgeLens model checks on 20 November

The tests ran in disposable VS Code profiles on a 16 GB Mac with TrueForge 0.185.1. The team connector exposed all six ForgeLens tools. The test driver requested an edit, recorded the tool responses and review-store hunks, and checked that the real file stayed unchanged during review. The approvals in these checks were automated.

| Model and task | Observed result |
| --- | --- |
| Qwen3 1.7B, isolated proof connector | The model read the file and requested approval for a real proposal. TrueForge recorded the test driver's denial. |
| Qwen3 1.7B, team connector, one-line edit | The model read a fresh label from a two-line file. It submitted placeholder IDs and incompatible edit arguments. No reviewable hunk appeared. |
| Qwen3 1.7B, same edit with sequential instructions | When asked to wait for each result, use the returned snapshot ID, and use only a line-range edit, the model staged the correct replacement, received approval and reported the fresh label. |
| Qwen3 1.7B, exact Task A prompt on the pinned function | It read the selection and attempted edits, but produced no reviewable hunk. |
| Qwen3 8B, team connector, ordinary one-line edit | It read the fresh label, staged the correct replacement, received approval through the editor command, and returned the label. The file stayed unchanged before Apply. |
| Qwen3 8B, exact Task A prompt and selection on Flask `22d92470` | It explained the desired code change in chat. The session contained zero tool calls and the review store contained zero hunks. |
| Qwen3 8B, same Task A prompt with session `reasoningEffort` set to `none` | It searched and read the source, then proposed the existing function text verbatim. The tool rejected the identical replacement. No hunk or approval request followed. |

The unmodified checkout failed the four expected Task A checks (`off`, `OFF`, `n`, `N`) and passed the six controls. Neither 8B run produced an edit to apply and retest. The one-line pass establishes that 8B can use the connector. For demo sign-off, require a reviewable Task A diff, a passing `demo/check_task_a.sh` after Apply and Save, and a separate live fallback run.

To repeat the small check, create `sample.txt` with a fresh `label=<random value>` on line 1 and `state=waiting` on line 2. Ask the agent to read the two lines, change only line 2 to `state=ready`, request approval, and report the label. Inspect the actual hunk and the approval event in TrueForge. A completed turn alone is insufficient evidence of a successful edit.

The local TrueForge instance had no configured Gemini or Groq provider. Their current account quota and authenticated tool calls remain untested here. The installed TrueForge catalog maps the Google model ID `gemini-3.1-flash-lite` to the registered model name `gemini-3-1-flash-lite`. Google lists a free tier for this model. [Google Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)

## Errors seen (newest first)

| Date | Model | Code | Error text | Meaning |
| --- | --- | --- | --- | --- |
| 17 Nov | qwen3:8b (Ollama) | none | Passed: list tools, get tool info, call list_agents | Chosen as backup. Sometimes stops after a tool error and needs a nudge. |
| 17 Nov | qwen3:1.7b (Ollama) | none | Called the wrong server name, then gave up | Too small for agent work. |
| 17 Nov | qwen/qwen3.8-27b (Groq) | none | tool call validation failed: attempted to call tool 'call Tool' which was not in request.tools | Invents tool names. Not usable. |
| 17 Nov | openai/gpt-oss-120b (Groq) | 400 | property 'reasoning_content' is unsupported | Breaks after the first tool call, with or without reasoning effort. Not usable. |
| 17 Nov | gemini-3-1-flash-lite | 400 | API key not valid. Please pass a valid API key. | Wrong key returns 400, not 401. |
| 17 Nov | gemini-3-5-flash | 503 | This model is currently experiencing high demand. | Temporary overload. About 8 s, likely including TrueForge's 2 automatic retries. |

## Fallback rules

- Auth error on the primary: switch to the backup once, immediately.
  Treat as auth: 401, 403, and **400 whose message says the API key is not valid** (Gemini's real behaviour).
- Overload, server error (5xx), timeout, 429: TrueForge already retries twice, so switch to the backup after its final failure.
- User pressed Cancel: never switch.
- If the primary may have executed `run_check`, stop and show the original failure. Check the command result before retrying manually. The harness stops automatic replay as soon as it sees the check awaiting approval. The TrueForge session UI can approve it even if the extension loses its subscription before seeing the result.
- On a switch: discard the primary's pending hunks, start a new session on the backup with the same instruction and selection, show "Primary model failed → using backup".
- Both models fail: one clear error, and the run ends.

## Still to do

- Test Gemini with a credential configured in TrueForge and capture the provider response.
- Rehearse Task A until the backup reliably produces a passing diff, then run Task B and the broken-primary Task C on the demo machine.
