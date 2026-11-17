import { readFile } from "node:fs/promises";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const model = process.argv[2]?.trim();
if (!model) throw new Error("Usage: node scripts/register-agent.mjs PROVIDER/MODEL");
const port = Number(process.env.TRUEFORGE_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid TRUEFORGE_PORT");
const client = new TrueForge({ baseUrl: "http://127.0.0.1:" + port, timeoutInSeconds: 600 });
const spec = JSON.parse(await readFile(new URL("../agent/forgelens.agent.json", import.meta.url), "utf8"));
spec.model.name = model;
await client.mcpServers.get("forgelens");
const result = await client.agents.create({ name: "forgelens", description: "ForgeLens editor agent", manifest: spec });
console.log("Registered ForgeLens agent " + result.data.id);
