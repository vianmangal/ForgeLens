# Models and resilience notes

Owner: Person 5 (Models and resilience). Last updated: 17 Nov 2026.

## Model setup in TrueForge

| Role | Provider entry | Model ID | Name in TrueForge | Where it runs | Cost |
| --- | --- | --- | --- | --- | --- |
| Primary | google-gemini (built-in) | gemini-3-1-flash-lite | gemini-3-1-flash-lite | Google cloud, free tier | Free |
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
- If the primary may have executed `run_check`, stop and show the original failure. Check the command result before retrying manually. The harness records this before sending TrueForge permission to execute the command, so a lost acknowledgement cannot cause a second execution.
- On a switch: discard the primary's pending hunks, start a new session on the backup with the same instruction and selection, show "Primary model failed → using backup".
- Both models fail: one clear error, and the run ends.

## Still to do

- Test both models on the team's own MCP tools once the harness server is up.
