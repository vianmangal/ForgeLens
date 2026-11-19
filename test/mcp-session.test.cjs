const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { startMcpServer } = require("../dist/mcp/server.js");

test("the authenticated connector permits discovery and dispatches tools only for the announced session", async t => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let activeSession;
  const dispatched = [];
  const server = await startMcpServer(port, "test-token", id => id === activeSession ? "run" : undefined,
    (mcp, currentRun) => mcp.registerTool("ping", {}, async () => {
      dispatched.push(currentRun());
      return { content: [{ type: "text", text: "ok" }] };
    }));
  t.after(() => server.dispose());
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  const client = new Client({ name: "fixture", version: "1" });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer test-token" } } });
  t.after(() => client.close());
  await client.connect(transport);
  assert.ok(transport.sessionId);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["ping"]);
  activeSession = transport.sessionId;
  await client.callTool({ name: "ping", arguments: {} });
  activeSession = undefined;
  await assert.rejects(client.callTool({ name: "ping", arguments: {} }), /no active ForgeLens run/);
  assert.deepEqual(dispatched, ["run"]);
  await transport.terminateSession();
});
