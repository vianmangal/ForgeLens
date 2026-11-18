const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const root = path.resolve(__dirname, "../..");
  await mkdir(path.join(root, ".local", "vscode-test"), { recursive: true });
  const temporary = await mkdtemp(path.join(tmpdir(), "forgelens-review-host-"));
  const workspace = path.join(temporary, "workspace");
  await mkdir(path.join(workspace, ".vscode"), { recursive: true });
  await writeFile(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({
    "forgelens.review.autoOpenDiff": false,
    "files.autoSave": "off",
    "workbench.startupEditor": "none",
    "workbench.editor.enablePreview": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none"
  }));
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite.cjs"),
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      version: process.env.VSCODE_VERSION || "stable",
      cachePath: path.join(root, ".local", "vscode-test"),
      launchArgs: [
        workspace,
        "--user-data-dir=" + path.join(temporary, "profile"),
        "--extensions-dir=" + path.join(temporary, "extensions"),
        "--disable-extensions",
        "--disable-workspace-trust",
        "--disable-gpu",
        "--skip-welcome",
        "--skip-release-notes",
        "--skip-add-to-recently-opened"
      ]
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error("ForgeLens extension-host tests failed:", error);
  process.exitCode = 1;
});
