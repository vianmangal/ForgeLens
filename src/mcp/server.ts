import type { Server as HttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export type ToolRegistrar = (server: McpServer, requestRunId: string | undefined) => void;

export interface RunningMcpServer {
  port: number;
  dispose(): Promise<void>;
}

// Starts the MCP HTTP endpoint on the configured loopback port.
export async function startMcpServer(
  port: number,
  authToken: string,
  currentRunId: () => string | undefined,
  registerTools: ToolRegistrar
): Promise<RunningMcpServer> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MCP port must be between 1 and 65535.");
  }

  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const activeConnections = new Set<() => Promise<void>>();
  let isStopping = false;
  let disposePromise: Promise<void> | undefined;

  // Requires the secret connector token; loopback and Host checks are not identity.
  app.use((req, res, next) => {
    if (req.path !== "/mcp") return next();
    const authorization = req.get("authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const expectedBytes = Buffer.from(authToken);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      res.set("WWW-Authenticate", "Bearer").status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized MCP connector." },
        id: null
      });
      return;
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    if (isStopping) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "MCP server is shutting down."
        },
        id: null
      });
      return;
    }

    // A fresh server and transport handle each stateless HTTP request.
    const mcpServer = new McpServer({
      name: "forgelens",
      version: "0.1.0"
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    let connectionClosed = false;

    const closeConnection = async (): Promise<void> => {
      if (connectionClosed) {
        return;
      }

      connectionClosed = true;
      activeConnections.delete(closeConnection);

      await Promise.allSettled([
        transport.close(),
        mcpServer.close()
      ]);
    };

    activeConnections.add(closeConnection);
    res.once("close", () => {
      void closeConnection();
    });

    try {
      // Pins this request to one server-observed run before asynchronous dispatch.
      const requestRunId = currentRunId();
      registerTools(mcpServer, requestRunId);
      await mcpServer.connect(transport);

      if (connectionClosed) {
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("ForgeLens MCP request failed.", error);
      await closeConnection();

      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error"
          },
          id: null
        });
      }
    }
  });

  const methodNotAllowed = {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  };

  app.get("/mcp", (_req, res) => {
    res.status(405).json(methodNotAllowed);
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json(methodNotAllowed);
  });

  const listener: HttpServer = app.listen(port, "127.0.0.1");

  await new Promise<void>((resolve, reject) => {
    listener.once("listening", () => resolve());
    listener.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`ForgeLens MCP port ${port} is already in use.`)
          : error
      );
    });
  });

  return {
    port,

    // Stops new tool calls, closes active requests, then releases the port.
    dispose() {
      if (!disposePromise) {
        isStopping = true;

        disposePromise = (async () => {
          const closed = new Promise<void>((resolve, reject) => {
            listener.close(error => error ? reject(error) : resolve());
          });
          listener.closeAllConnections();
          await Promise.allSettled([...activeConnections].map(closeConnection => closeConnection()));
          await closed;
        })();
      }

      return disposePromise;
    }
  };
}
