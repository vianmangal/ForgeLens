# Model configuration example

Placeholders only. Enter real keys in the TrueForge UI (`http://localhost:8790`, Settings → Model Providers). Never put a key in this repository, in `agent/forgelens.agent.json` or in VS Code settings. ForgeLens sends prompts to local TrueForge only; TrueForge calls the providers.

## 1. Primary provider (cloud)

| Field | Value |
| --- | --- |
| Provider type | Built-in `google-gemini` |
| API key | `<GEMINI_API_KEY>` (entered in TrueForge only) |
| Model ID | `gemini-3-1-flash-lite` |
| Model name in TrueForge | `<primary-model-name>` |
| Hosting / cost | Google cloud, free tier. `TODO: confirm cost` |

## 2. Backup provider (local, separate from the primary)

| Field | Value |
| --- | --- |
| Provider type | Custom provider |
| Provider name | `<backup-provider-name>` (for example `ollama`) |
| Base URL | `http://localhost:11434/v1` |
| API key | blank |
| Model ID | `qwen3:8b` |
| Model name in TrueForge | `<backup-model-name>` (for example `qwen3-8b`) |
| Context length | `32768` |
| Max output tokens | `8192` |
| Reasoning effort | ticked, set to `none` |
| Prerequisite | `ollama pull qwen3:8b`, and Ollama running |
| Hosting / cost | Local, no per-token charge. `TODO: confirm cost` |

TrueForge must be started with the allowlist for loopback hosts, otherwise the local provider URL is refused:

```sh
HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx --yes @truefoundry/trueforge@0.185.1
```

## 3. ForgeLens settings

Each model is referenced as the complete `<provider-name>/<model-name>` string shown in TrueForge. Put these in the workspace `.vscode/settings.json`:

```json
{
  "forgelens.primaryModel": "<primary-provider>/<primary-model-name>",
  "forgelens.backupModel": "<backup-provider>/<backup-model-name>"
}
```

To switch models, change `forgelens.primaryModel` and start a new run. Leave `forgelens.backupModel` blank to turn automatic fallback off.

## 4. Task C: a deliberately failing primary

Either save an invalid key in the primary provider in TrueForge, or add a separate provider with a placeholder key such as `<INVALID_KEY>` and point `forgelens.primaryModel` at it. Do not display a real key on screen.
