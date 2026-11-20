const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");

const uri = path => ({ path, fsPath: path, scheme: "file" });
const vscode = {
  __esModule: true,
  Uri: { joinPath: (base, name) => uri(path.join(base.path, name)) },
  FileType: { Directory: 2, File: 1, SymbolicLink: 64 },
  workspace: {
    isTrusted: true,
    asRelativePath: target => path.basename(target.path),
    fs: {
      stat: async target => {
        const stat = await fs.lstat(target.path);
        return { size: stat.size, type: stat.isDirectory() ? 2 : 1 };
      },
      readFile: target => fs.readFile(target.path),
      readDirectory: async target => (await fs.readdir(target.path, { withFileTypes: true }))
        .map(entry => [entry.name, entry.isDirectory() ? 2 : 1])
    }
  }
};
const originalLoad = Module._load;
let searchText, prepareMentionInput, budgetSelection;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? vscode : originalLoad.call(this, name, ...args); };
  ({ searchText } = require("../dist/context/search.js"));
  ({ prepareMentionInput, budgetSelection } = require("../dist/context/mentions.js"));
} finally {
  Module._load = originalLoad;
}
const { RunContextBudget } = require("../dist/context/budget.js");
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgelens-retrieval-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  vscode.workspace.workspaceFolders = [{ uri: uri(root) }];
  return root;
}

test("search applies the repository case policy to gitignore exceptions", async t => {
  const root = await workspace(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await fs.writeFile(path.join(root, ".gitignore"), "*\n!README.txt\n");
  await fs.writeFile(path.join(root, "readme.txt"), "needle\n");
  for (const ignoreCase of [false, true]) {
    execFileSync("git", ["config", "core.ignoreCase", String(ignoreCase)], { cwd: root });
    const response = await searchText("needle", new RunContextBudget("test", 1000));
    assert.deepEqual(response.results.map(row => row.path), ignoreCase ? ["readme.txt"] : []);
  }
});

test("a confirmed fuzzy symbol uses the selected name even if the definition moved", async t => {
  const root = await workspace(t);
  const target = uri(path.join(root, "a.ts"));
  await fs.writeFile(target.path, "// heading\nfunction loadConfig() {}");
  const names = [];
  vscode.SymbolKind = { 11: "Function" };
  vscode.commands = { executeCommand: async (_command, name) => {
    names.push(name);
    const line = names.length === 1 ? 0 : 1;
    return [{ name: "loadConfig", kind: 11, location: { uri: target, range: { start: { line }, end: { line } } } }];
  } };
  vscode.workspace.openTextDocument = async () => {
    const text = await fs.readFile(target.path, "utf8");
    return { uri: target, lineCount: 2, getText: () => text, lineAt: n => ({ text: text.split("\n")[n] }) };
  };
  vscode.window = { createQuickPick: () => ({
    get selectedItems() { return this.items; }, onDidAccept(cb) { this.accept = cb; },
    onDidHide() {}, show() { this.accept(); }, dispose() {}
  }) };
  const result = await prepareMentionInput("@symbol(load)", new RunContextBudget("test", 1000), new AbortController().signal);
  assert.deepEqual(names, ["load", "loadConfig"]);
  assert.match(result.instruction, /2: function loadConfig\(\)/);
});

test("search ranks a definition above a similarly named file's call sites and plain text, then truncates at a small budget", async t => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, "tasks"));
  await fs.mkdir(path.join(root, "docs"));
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "tasks", "commands.py"), "import os\n\ndef run_command(name):\n    return name\n");
  await fs.writeFile(path.join(root, "tasks", "command.py"), "from tasks.commands import run_command\n\nprint(run_command('x'))\n");
  await fs.writeFile(path.join(root, "docs", "usage.txt"), "Use run_commands to batch several.\n");
  await fs.writeFile(path.join(root, "node_modules", "dep.py"), "def run_command():\n    pass\n");
  const full = await searchText("run_command", new RunContextBudget("full", 10_000));
  assert.deepEqual(full.results.map(r => [r.path, r.startLine, r.signal]), [
    ["tasks/commands.py", 3, "symbol_definition"],
    ["tasks/command.py", 1, "identifier_match"],
    ["tasks/command.py", 3, "identifier_match"],
    ["docs/usage.txt", 1, "text_match"]
  ]);
  assert.equal(full.budgetExhausted, false);
  const limit = full.contextRows[0].costTokens + full.contextRows[1].costTokens;
  const small = new RunContextBudget("small", limit);
  const bounded = await searchText("run_command", small);
  assert.deepEqual(bounded.results.map(r => r.path), ["tasks/commands.py", "tasks/command.py"]);
  assert.equal(bounded.results[0].signal, "symbol_definition");
  assert.equal(bounded.budgetExhausted, true);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.contextRows.map(row => [row.sentToModel, row.exclusion]), [[true, undefined], [true, undefined], [false, "over_budget"]]);
  assert.ok(small.cumulativeTokens <= limit);
  assert.ok(bounded.contextRows.every(row => row.limitTokens === limit && row.cumulativeTokens <= limit));
});

test("an inline selection is charged to the run budget and shortened by whole lines when it does not fit", () => {
  const selection = { path: "a.py", startLine: 10, endLine: 12, text: "def f():\n    return 1\n    # " + "x".repeat(60) + "\n", documentVersion: 3 };
  const roomy = new RunContextBudget("roomy", 1000);
  const whole = budgetSelection(selection, roomy);
  assert.equal(whole.selection, selection);
  assert.deepEqual([whole.row.tool, whole.row.sentToModel, whole.row.startLine, whole.row.endLine], ["selection", true, 10, 12]);
  assert.equal(whole.row.costTokens, Math.ceil(Buffer.byteLength(JSON.stringify(selection)) / 4));
  const twoLines = { ...selection, text: "def f():\n    return 1\n", truncated: true };
  const tight = new RunContextBudget("tight", Math.ceil(Buffer.byteLength(JSON.stringify(twoLines)) / 4));
  const partial = budgetSelection(selection, tight);
  assert.deepEqual(partial.selection, twoLines);
  assert.deepEqual([partial.row.exclusion, partial.row.endLine, tight.remainingTokens], ["truncated", 11, 0]);
  const none = budgetSelection(selection, new RunContextBudget("none", 5));
  assert.deepEqual([none.selection.text, none.selection.truncated, none.row.exclusion, none.row.costTokens], ["", true, "over_budget", 0]);
  assert.deepEqual(budgetSelection({ path: "a.py", startLine: 1, endLine: 1 }, roomy), { selection: { path: "a.py", startLine: 1, endLine: 1 } });
});

test("symbol provider results inside dependency or generated folders are dropped", async t => {
  const root = await workspace(t);
  const at = relative => ({ uri: uri(path.join(root, relative)), range: { start: { line: 4 }, end: { line: 9 } } });
  vscode.SymbolKind = { 11: "Function" };
  vscode.commands = { executeCommand: async () => [
    { name: "run_command", kind: 11, location: at(".venv/lib/python3.12/site-packages/pkg/cli.py") },
    { name: "run_command", kind: 11, location: at("node_modules/pkg/index.js") },
    { name: "run_command", kind: 11, location: at("build/lib/cli.py") },
    { name: "run_command", kind: 11, location: at("src/cli.py") }
  ] };
  const saved = vscode.workspace.asRelativePath;
  vscode.workspace.asRelativePath = target => path.relative(root, target.path);
  t.after(() => { vscode.workspace.asRelativePath = saved; });
  const { findSymbol } = (() => {
    const load = Module._load;
    try {
      Module._load = function(name, ...args) { return name === "vscode" ? vscode : load.call(this, name, ...args); };
      return require("../dist/context/symbols.js");
    } finally {
      Module._load = load;
    }
  })();
  const response = await findSymbol("run_command", new RunContextBudget("symbols", 1000));
  assert.equal(response.source, "workspace_provider");
  assert.deepEqual(response.results.map(result => [result.path, result.startLine, result.endLine]), [["src/cli.py", 5, 10]]);
});

test("a capped search reports the first omitted location and count without charging its excerpt", async t => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "demo.txt"), "target first\ntarget second\ntarget last\n");
  const reply = await searchText("target", new RunContextBudget("cap", 6000), undefined, 1);
  assert.equal(reply.results.length, 1);
  const [included, excluded] = reply.contextRows;
  assert.deepEqual([excluded.exclusion, excluded.omittedMatches, excluded.path, excluded.startLine,
    excluded.costTokens, excluded.cumulativeTokens], ["result_limit", 2, "demo.txt", 2, 0, included.costTokens]);
});
