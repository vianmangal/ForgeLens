import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk" with { "resolution-mode": "import" };

export interface ProofHunk {
  id: string;
  oldText: string;
  newText: string;
}

export class ProofFixture {
  readonly path = "proof-" + randomBytes(5).toString("hex") + ".txt";
  private readonly snapshotId = "s-" + randomBytes(5).toString("hex");
  private source?: string;
  hunk?: ProofHunk;

  constructor(private readText: () => Promise<string>, private active: () => boolean,
    private register: (id: string) => boolean) {}

  async read(path: string, startLine: number, endLine: number) {
    if (!this.active() || path !== this.path || startLine !== 2 || endLine !== 2) {
      throw new Error("Read line 2 of the current proof file only.");
    }
    const source = (await this.readText()).split(/\r?\n/)[1];
    if (!this.active() || source === undefined) throw new Error("Proof is inactive or the fixture is incomplete.");
    this.source = source;
    return { path, startLine, endLine, text: source, snapshotId: this.snapshotId };
  }

  propose(snapshotId: string, newText: string) {
    if (!this.active() || this.source === undefined || snapshotId !== this.snapshotId) {
      throw new Error("Read the current proof file and use the returned snapshotId.");
    }
    if (!newText.trim() || newText.includes("\n") || newText === this.source) throw new Error("Supply one changed line.");
    if (this.hunk && this.hunk.newText !== newText) throw new Error("This proof already has one hunk.");
    const hunk = this.hunk ?? { id: "h-" + randomBytes(5).toString("hex"), oldText: this.source, newText };
    if (!this.register(hunk.id)) throw new Error("The owning run is inactive.");
    this.hunk = hunk;
    return { hunkIds: [hunk.id] };
  }

  acknowledge(hunkId: string) {
    if (!this.active() || this.hunk?.id !== hunkId) throw new Error("Unknown or inactive proof hunk.");
    return { hunkId, message: "Approval gate passed. Preview remains in memory." };
  }
}

export function proofSpec(agent: TrueForgeApi.AgentSpec): TrueForgeApi.AgentSpec {
  return { ...agent, model: { ...agent.model, params: { ...agent.model.params, temperature: 0, parallelToolCalls: false } },
    instructions: agent.instructions + " In this connector proof, send exactly one tool call per assistant message. Stop and wait for its result. Never predict snapshotId or hunkId. If a tool reports an invalid ID, recover using the last successful tool response. A human denial of a real hunk is final.",
    config: { ...agent.config, iterationLimit: 12 },
    mcpServers: [{ name: "forgelens-proof", preload: true, enableTools: ["read_range", "propose_edit", "approve_hunk"], requireApprovalForTools: ["approve_hunk"] }] };
}

export function proofInstruction(fixture: ProofFixture) {
  return 'First call only read_range on "' + fixture.path + '" with startLine 2 and endLine 2. Wait for the tool response. ' +
    'Then call only propose_edit with the exact snapshotId from that response and newText "The copper owl counted eight bells.". ' +
    'Wait for propose_edit to return hunkIds. Then call only approve_hunk with its first exact hunk ID. After the decision, quote the original line and stop.';
}

export async function listenProof(port: number, current: () => ProofFixture | undefined) {
  const get = () => {
    const fixture = current();
    if (!fixture) throw new Error("Start a ForgeLens harness proof first.");
    return fixture;
  };
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const server = createServer(async (req, res) => {
    if (req.url !== "/mcp" || req.headers.host !== "127.0.0.1:" + port || req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const mcp = new McpServer({ name: "forgelens-proof", version: "0.1.0" });
    mcp.registerTool("read_range", {
      description: "Read line 2 of the named proof file. Returns text and snapshotId.",
      inputSchema: { path: z.string(), startLine: z.number().int(), endLine: z.number().int() },
      annotations: { readOnlyHint: true }
    }, async ({ path, startLine, endLine }) => result(await get().read(path, startLine, endLine)));
    mcp.registerTool("propose_edit", {
      description: "Stage one replacement line in memory using snapshotId. Returns hunkIds.",
      inputSchema: { snapshotId: z.string(), newText: z.string().max(1024) }
    }, async ({ snapshotId, newText }) => result(get().propose(snapshotId, newText)));
    mcp.registerTool("approve_hunk", {
      description: "Request human approval for the staged hunk's exact hunkId.",
      inputSchema: { hunkId: z.string() }
    }, async ({ hunkId }) => result(get().acknowledge(hunkId)));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once("close", () => { void mcp.close().catch(() => undefined); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { close: async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    server.closeAllConnections();
    await closed;
  } };
}
