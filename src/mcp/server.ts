import type { Server as HttpServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export type ToolRegistrar = (server: McpServer, currentRunId: () => string | undefined) => void;

export interface RunningMcpServer {
  port: number;
  dispose(): Promise<void>;
}

interface Connection {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
}

// The client may discover tools before the turn announces its MCP session.
export async function startMcpServer(
  port: number,
  authToken: string,
  runForSession: (sessionId: string) => string | undefined,
  registerTools: ToolRegistrar
): Promise<RunningMcpServer> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MCP port must be between 1 and 65535.");
  }
  if (!authToken) throw new Error("A connector token is required.");

  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const sessions = new Map<string, Connection>();
  const expected = Buffer.from("Bearer " + authToken);
  let disposePromise: Promise<void> | undefined;

  app.all("/mcp", async (req, res) => {
    const supplied = Buffer.from(req.get("authorization") ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      res.set("WWW-Authenticate", "Bearer").status(401).json({
        jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized MCP connector." }, id: null
      });
      return;
    }
    if (disposePromise) { res.sendStatus(503); return; }
    if (!["POST", "GET", "DELETE"].includes(req.method)) {
      res.set("Allow", "POST, GET, DELETE").sendStatus(405);
      return;
    }

    const sessionId = req.get("mcp-session-id");
    let connection = sessionId ? sessions.get(sessionId) : undefined;
    try {
      if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        const id = randomUUID();
        const server = new McpServer({ name: "forgelens", version: "0.1.0" });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
        connection = { server, transport, lastUsed: Date.now() };
        registerTools(server, () => runForSession(id));
        sessions.set(id, connection);
        transport.onclose = () => { sessions.delete(id); };
        await server.connect(transport);
      }
      if (!connection) {
        res.status(sessionId ? 404 : 400).json({
          jsonrpc: "2.0", error: { code: -32000, message: "Initialize a ForgeLens MCP session first." }, id: null
        });
        return;
      }
      connection.lastUsed = Date.now();
      const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
      const callsTool = messages.some(msg => msg && typeof msg === "object" && "method" in msg && msg.method === "tools/call");
      if (callsTool && (!sessionId || !runForSession(sessionId))) {
        res.status(403).json({
          jsonrpc: "2.0", error: { code: -32001, message: "This MCP session has no active ForgeLens run." },
          id: req.body?.id ?? null
        });
        return;
      }
      await connection.transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("ForgeLens MCP request failed.", error);
      if (connection && !sessionId) await connection.server.close();
      if (!res.headersSent) res.sendStatus(500);
    }
  });

  const listener: HttpServer = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new Error(`ForgeLens MCP port ${port} is already in use.`) : error));
  });

  // Discovery clients and interrupted turns may leave without sending DELETE.
  const idleMs = 60_000;
  const sweep = setInterval(() => {
    for (const [id, session] of sessions) {
      if (Date.now() - session.lastUsed > idleMs && !runForSession(id)) void session.server.close().catch(console.error);
    }
  }, idleMs).unref();

  return {
    port,
    dispose() {
      if (!disposePromise) {
        clearInterval(sweep);
        disposePromise = (async () => {
          const closed = new Promise<void>((resolve, reject) => {
            listener.close(error => error ? reject(error) : resolve());
          });
          listener.closeAllConnections();
          await Promise.allSettled([...sessions.values()].map(session => session.server.close()));
          await closed;
        })();
      }
      return disposePromise;
    }
  };
}
