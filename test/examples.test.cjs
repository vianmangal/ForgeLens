const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../package.json");

const properties = manifest.contributes.configuration.properties;
const settingsFiles = ["../examples/vscode-settings.json", "../demo/vscode-settings.json"];

test("example settings use only declared ForgeLens settings with valid check profiles", () => {
  for (const file of settingsFiles) {
    const settings = require(file);
    for (const [key, value] of Object.entries(settings)) {
      assert.ok(properties[key], file + " uses undeclared setting " + key);
      if (properties[key].type === "integer" || properties[key].type === "number") assert.equal(typeof value, "number");
      if (properties[key].type === "string") assert.equal(typeof value, "string");
    }
    for (const profile of settings["forgelens.checkProfiles"] ?? []) {
      assert.deepEqual(Object.keys(profile).sort(), ["args", "id"]);
      assert.equal(typeof profile.id, "string");
      assert.ok(profile.args.every(arg => typeof arg === "string"));
    }
  }
  assert.equal(require("../examples/vscode-settings.json")["forgelens.contextBudget"], properties["forgelens.contextBudget"].default);
});

test("the example connector matches the default port and carries a placeholder instead of a credential", () => {
  const connector = require("../examples/trueforge-connector.json");
  const agent = require("../agent/forgelens.agent.json");
  assert.equal(connector.name, agent.mcpServers[0].name);
  assert.equal(connector.type, "remote");
  assert.equal(connector.url, "http://127.0.0.1:" + properties["forgelens.mcpPort"].default + "/mcp");
  assert.equal(connector.auth.type, "header");
  assert.match(connector.auth.headers.Authorization, /^Bearer <[^>]+>$/);
});

test("example files contain no credential-shaped values", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const file of ["examples/vscode-settings.json", "examples/trueforge-connector.json", "demo/vscode-settings.json"]) {
    const text = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(text, /[A-Za-z0-9_-]{32,}|sk-[A-Za-z0-9]|AIza[0-9A-Za-z_-]{10}/, file);
  }
});
