const test = require("node:test");
const assert = require("node:assert/strict");
const agent = require("../agent/forgelens.agent.json");

const connector = agent.mcpServers.find(server => server.name === "forgelens");

test("the agent instructions describe the discovery, bounded read, minimal edit and per-hunk approval workflow", () => {
  const text = agent.instructions;
  for (const tool of ["search_text", "find_symbol", "read_range", "propose_edit", "approve_hunk", "run_check"]) {
    assert.match(text, new RegExp("\\b" + tool + "\\b"), tool);
  }
  assert.match(text, /search_text and find_symbol[^.]*before reading/);
  assert.match(text, /bounded ranges of at most \d+ lines/);
  assert.match(text, /CLI command/);
  assert.match(text, /tests that cover it and the documentation that lists it/);
  assert.match(text, /smallest edits/);
  assert.match(text, /approve_hunk exactly once for every returned hunkId/);
  assert.match(text, /denied hunk is final/);
  assert.match(text, /budget_exhausted/);
});

test("the agent instructions contain no fixture-specific filenames or solutions", () => {
  const text = agent.instructions;
  assert.doesNotMatch(text, /flask|pallets|werkzeug|click\b/i);
  assert.doesNotMatch(text, /\b(src|tests?|docs|examples)\/|\b[\w-]+(\/[\w-]+)+\.\w+|\b[\w-]+\.(py|rst|md|txt|toml|cfg|ini|json)\b/);
  assert.doesNotMatch(text, /get_debug_flag|PERMANENT_SESSION_LIFETIME|SECRET|PASSWORD|\*\*\*|test_cli|routes_command|timedelta/);
  assert.doesNotMatch(text, /\bconfig\b/);
});

test("the connector exposes an explicit tool list, preloads frequent tools and defers run_check", () => {
  assert.ok(connector);
  assert.equal(agent.mcpServers.length, 1);
  assert.deepEqual(connector.enableTools, ["search_text", "find_symbol", "read_range", "propose_edit", "approve_hunk", "run_check"]);
  assert.notEqual(connector.preload, true);
  assert.ok(connector.preloadTools.length > 0);
  assert.ok(connector.preloadTools.every(tool => connector.enableTools.includes(tool)));
  assert.deepEqual(connector.enableTools.filter(tool => !connector.preloadTools.includes(tool)), ["run_check"]);
  assert.ok(connector.requireApprovalForTools.includes("approve_hunk"));
  assert.ok(connector.requireApprovalForTools.every(tool => connector.enableTools.includes(tool)));
  assert.ok(!connector.requireApprovalForTools.some(tool => tool.startsWith("@")));
  assert.equal(agent.config.askUserQuestions.enabled, false);
});
