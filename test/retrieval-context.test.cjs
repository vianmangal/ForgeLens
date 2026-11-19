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
let searchText, prepareMentionInput;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? vscode : originalLoad.call(this, name, ...args); };
  ({ searchText } = require("../dist/context/search.js"));
  ({ prepareMentionInput } = require("../dist/context/mentions.js"));
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
