import { TrueForge } from "@truefoundry/trueforge-sdk";

function port(name, fallback) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("Invalid " + name);
  return n;
}

const client = new TrueForge({ baseUrl: "http://127.0.0.1:" + port("TRUEFORGE_PORT", 8790), timeoutInSeconds: 600 });
const provider = {
  name: "forgelens-local", type: "custom", baseUrl: "http://127.0.0.1:" + port("OLLAMA_PORT", 11436) + "/v1",
  models: [{ name: "qwen-proof", modelId: "qwen3:1.7b", properties: { contextLength: 8192, maxOutputTokens: 2048 } }]
};
const connector = {
  name: "forgelens-proof", type: "remote", description: "ForgeLens in-memory harness fixture",
  url: "http://127.0.0.1:" + port("FORGELENS_PROOF_PORT", 8792) + "/mcp"
};

const providers = await client.settings.modelProviders.list();
const existing = providers.data.find(p => p.name === provider.name);
if (!existing) await client.settings.modelProviders.create({ manifest: provider });
else if (existing.manifest.baseUrl !== provider.baseUrl ||
  !existing.manifest.models.some(m => m.name === "qwen-proof" && m.modelId === "qwen3:1.7b")) {
  throw new Error("Existing forgelens-local configuration differs. Check its endpoint and model in TrueForge.");
}
const connectors = await client.settings.mcpServers.list();
const configured = connectors.data.find(p => p.name === connector.name);
if (!configured) await client.settings.mcpServers.create({ manifest: connector });
else if (configured.manifest.url !== connector.url) throw new Error("Existing forgelens-proof connector has a different URL.");
console.log("Model: forgelens-local/qwen-proof\nConnector: " + connector.url);
