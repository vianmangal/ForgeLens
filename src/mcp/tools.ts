import * as vscode from "vscode";
import * as z from "zod/v4";
import { execFile, spawn } from "node:child_process";
import { kill as killProcess, platform } from "node:process";
import { RunContextBudget } from "../context/budget";
import { findSymbol } from "../context/symbols";
import { searchText } from "../context/search";
import type { ContextRow, SourceSnapshot } from "../shared/types";
import type { ReviewApi } from "../review";
import type { ProposalRequest } from "../review/hunks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type CurrentRunId = () => string | undefined;

export interface ForgeLensToolContext {
  review: ReviewApi;
  currentRunId: CurrentRunId;
  registerProposed: (runId: string, hunkId: string) => boolean;
  onContextRows?: (runId: string, rows: ContextRow[]) => void;
}

const budgetsByRun = new Map<string, RunContextBudget>();
const encoder = new TextEncoder();
const MAX_CHECK_OUTPUT_CHARS = 16_000;
const MAX_CHECK_RUNTIME_MS = 120_000;

// Reuses one context ledger per run so concurrent retrieval calls share its budget.
export function getBudgetForRun(runId: string): RunContextBudget {
  let budget = budgetsByRun.get(runId);

  if (!budget) {
    const limitTokens = vscode.workspace
      .getConfiguration("forgelens")
      .get<number>("contextBudget", 6000);

    budget = new RunContextBudget(runId, limitTokens);
    budgetsByRun.set(runId, budget);
  }

  return budget;
}

// Drops the run's ledger once ForgeLens no longer needs its retrieval history.
export function clearBudgetForRun(runId: string): void {
  budgetsByRun.delete(runId);
}

function result(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {})
  };
}

function currentRun(context: ForgeLensToolContext): string | undefined {
  const runId = context.currentRunId();
  return runId && context.review.store.getRun(runId)?.active ? runId : undefined;
}

// Resolves a relative file path only inside the single trusted workspace.
async function resolveWorkspaceDocument(path: string): Promise<vscode.TextDocument> {
  const folders = vscode.workspace.workspaceFolders;
  if (!vscode.workspace.isTrusted || folders?.length !== 1) {
    throw new Error("Open one trusted workspace folder before reading files.");
  }

  const normalized = path.trim().replace(/\\/g, "/");
  const segments = normalized.split("/").filter(segment => segment && segment !== ".");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.includes("..")
  ) {
    throw new Error("Path must be relative to the workspace and cannot contain '..'.");
  }

  const root = folders[0].uri;
  if (segments.length === 0) {
    throw new Error("Path must identify a workspace file.");
  }

  let uri = root;
  // Checks every parent directory so an in-workspace symlink cannot escape the root.
  for (let index = 0; index < segments.length; index += 1) {
    uri = vscode.Uri.joinPath(uri, segments[index]);
    const stat = await vscode.workspace.fs.stat(uri);
    const isLastSegment = index === segments.length - 1;
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0 ||
      (isLastSegment ? (stat.type & vscode.FileType.File) === 0 : (stat.type & vscode.FileType.Directory) === 0)) {
      throw new Error("Path must identify a regular file without traversing symbolic links.");
    }
  }

  const rootPath = root.path.replace(/\/+$/, "");
  if (
    uri.scheme !== root.scheme ||
    uri.authority !== root.authority ||
    !uri.path.startsWith(rootPath + "/")
  ) {
    throw new Error("Path must stay inside the workspace.");
  }

  return vscode.workspace.openTextDocument(uri);
}

// Registers workspace search with a run ID obtained only from ForgeLens state.
export function registerSearchTextTool(
  server: McpServer,
  context: ForgeLensToolContext
): void {
  server.registerTool(
    "search_text",
    {
      description: "Search workspace text and return ranked, budgeted excerpts.",
      inputSchema: {
        query: z.string().min(1).max(256),
        scope: z.string().optional(),
        limit: z.number().int().min(1).max(30).optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query, scope, limit }) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);

      try {
        const response = await searchText(query, getBudgetForRun(runId), scope, limit ?? 10);
        context.onContextRows?.(runId, response.contextRows);
        return result(response);
      } catch (error) {
        return result({ status: "error", message: error instanceof Error ? error.message : "Search failed." }, true);
      }
    }
  );
}

// Registers VS Code symbol lookup and its bounded lexical fallback.
export function registerFindSymbolTool(
  server: McpServer,
  context: ForgeLensToolContext
): void {
  server.registerTool(
    "find_symbol",
    {
      description: "Find workspace symbol definitions and return bounded evidence.",
      inputSchema: {
        name: z.string().min(1).max(256),
        pathHint: z.string().max(512).optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ name, pathHint }) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);

      try {
        const response = await findSymbol(name, getBudgetForRun(runId), pathHint);
        context.onContextRows?.(runId, response.contextRows);
        return result(response);
      } catch (error) {
        return result({ status: "error", message: error instanceof Error ? error.message : "Symbol lookup failed." }, true);
      }
    }
  );
}

// Reads the open editor buffer when available and captures the exact version used for edits.
export function registerReadRangeTool(
  server: McpServer,
  context: ForgeLensToolContext
): void {
  server.registerTool(
    "read_range",
    {
      description: "Read a bounded workspace line range and return its source snapshot.",
      inputSchema: {
        path: z.string().min(1).max(1024),
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1)
      },
      annotations: { readOnlyHint: true }
    },
    async ({ path, startLine, endLine }) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);

      try {
        if (endLine < startLine || endLine - startLine > 299) {
          throw new Error("Choose a valid range of at most 300 lines.");
        }

        const document = await resolveWorkspaceDocument(path);
        if (endLine > document.lineCount) {
          throw new Error(`Requested lines ${startLine}-${endLine}, but the file has ${document.lineCount} lines.`);
        }

        const snapshotRecord = context.review.store.captureSnapshot(document);
        const snapshot: SourceSnapshot = {
          snapshotId: snapshotRecord.snapshotId,
          path: snapshotRecord.path.replace(/\\/g, "/"),
          documentVersion: snapshotRecord.documentVersion,
          contentHash: snapshotRecord.contentHash
        };
        const budget = getBudgetForRun(runId);
        const sourceLines = document.getText().split(/\r?\n/);
        const selected: string[] = [];
        let truncated = false;

        for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
          const numberedLine = `${lineNumber}: ${sourceLines[lineNumber - 1] ?? ""}`;
          const candidateText = [...selected, numberedLine].join("\n");
          const candidateEndLine = startLine + selected.length;
          const candidatePayload = {
            path: snapshot.path,
            startLine,
            endLine: candidateEndLine,
            text: candidateText,
            snapshot,
            snapshotId: snapshot.snapshotId
          };
          if (Math.ceil(encoder.encode(JSON.stringify(candidatePayload)).byteLength / 4) > budget.remainingTokens) {
            truncated = true;
            break;
          }
          selected.push(numberedLine);
        }

        const text = selected.join("\n");
        const actualEndLine = selected.length ? startLine + selected.length - 1 : startLine;
        const content = JSON.stringify({
          path: snapshot.path,
          startLine,
          endLine: actualEndLine,
          text,
          snapshot,
          snapshotId: snapshot.snapshotId
        });
        const row = budget.reserve({
          tool: "read_range",
          query: `${snapshot.path}:${startLine}-${endLine}`,
          path: snapshot.path,
          startLine,
          endLine: actualEndLine,
          signal: "path_match",
          content,
          truncated
        });
        context.onContextRows?.(runId, [row]);

        if (!row.sentToModel) {
          return result({
            status: "budget_exhausted",
            message: "The run's context budget is exhausted.",
            path: snapshot.path,
            snapshot,
            contextRows: [row],
            truncated: true
          });
        }

        return result({
          status: "ok",
          path: snapshot.path,
          startLine,
          endLine: actualEndLine,
          text,
          snapshot,
          snapshotId: snapshot.snapshotId,
          contextRows: [row],
          truncated: truncated || actualEndLine < endLine
        });
      } catch (error) {
        return result({ status: "error", message: error instanceof Error ? error.message : "Range read failed." }, true);
      }
    }
  );
}

// Stages a snapshot-checked range or unique text-anchor proposal without writing to disk.
export function registerProposeEditTool(
  server: McpServer,
  context: ForgeLensToolContext
): void {
  server.registerTool(
    "propose_edit",
    {
      description: "Propose a snapshot-validated edit for human review; never writes files.",
      inputSchema: {
        snapshotId: z.string().min(1).max(128),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(0).optional(),
        oldText: z.string().min(1).max(100_000).optional(),
        newText: z.string().max(100_000)
      }
    },
    async ({ snapshotId, startLine, endLine, oldText, newText }) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);

      const isRange = startLine !== undefined && endLine !== undefined && oldText === undefined;
      const isAnchor = startLine === undefined && endLine === undefined && oldText !== undefined;
      if (!isRange && !isAnchor) {
        return result({ status: "error", message: "Provide either startLine/endLine or oldText, but not both." }, true);
      }

      const request: ProposalRequest = isRange
        ? { kind: "range", startLine: startLine!, endLine: endLine!, newText }
        : { kind: "anchor", oldText: oldText!, newText };
      const proposed = context.review.store.propose(runId, snapshotId, request);
      if (!proposed.ok) return result({ status: "error", message: proposed.error }, true);

      for (const hunkId of proposed.hunkIds) {
        const hunk = context.review.store.getHunk(hunkId);
        if (!hunk || hunk.runId !== runId || !context.registerProposed(runId, hunkId)) {
          return result({ status: "error", message: "The run ended before the proposed hunk could be registered." }, true);
        }
      }

      return result({ status: "ok", hunkIds: proposed.hunkIds });
    }
  );
}

// Returns the decision recorded by the human review flow for a hunk in this run.
export function registerApproveHunkTool(
  server: McpServer,
  context: ForgeLensToolContext
): void {
  server.registerTool(
    "approve_hunk",
    {
      description: "Return the human review decision for a hunk owned by the current run.",
      inputSchema: { hunkId: z.string().min(1).max(128) }
    },
    async ({ hunkId }) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);

      const hunk = context.review.store.getHunk(hunkId);
      if (!hunk || hunk.runId !== runId) {
        return result({ status: "error", message: "This hunk does not belong to the current run." }, true);
      }
      if (hunk.status !== "accepted" && hunk.status !== "rejected") {
        return result({ status: "pending", message: "The human review decision is not complete yet." });
      }

      return result({ status: hunk.status, hunkId });
    }
  );
}

// Runs only a configured Python profile, bounds output and kills the process tree on cancel.
export function registerRunCheckTool(
  server: McpServer,
  context: ForgeLensToolContext
): void {
  server.registerTool(
    "run_check",
    {
      description: "Run one configured Python check profile in the workspace.",
      inputSchema: { checkId: z.string().min(1).max(128) }
    },
    async ({ checkId }, extra) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);

      const folders = vscode.workspace.workspaceFolders;
      if (!vscode.workspace.isTrusted || folders?.length !== 1) {
        return result({ status: "error", message: "Open one trusted workspace folder before running checks." }, true);
      }

      const profiles = vscode.workspace.getConfiguration("forgelens").get<unknown[]>("checkProfiles", []);
      const profile = profiles.find(value =>
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        value.id === checkId
      ) as { id: string; args?: unknown } | undefined;
      if (!profile || !Array.isArray(profile.args) || !profile.args.every(arg => typeof arg === "string")) {
        return result({ status: "error", message: "Unknown check profile or invalid profile arguments." }, true);
      }

      const pythonPath = vscode.workspace.getConfiguration("forgelens").get<string>("pythonPath", "python").trim();
      if (!pythonPath) return result({ status: "error", message: "Set forgelens.pythonPath to the selected Python executable." }, true);

      const child = spawn(pythonPath, profile.args, {
        cwd: folders[0].uri.fsPath,
        shell: false,
        windowsHide: true,
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let outputTruncated = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const current = target === "stdout" ? stdout : stderr;
        const available = MAX_CHECK_OUTPUT_CHARS - current.length;
        if (text.length > available) outputTruncated = true;
        const bounded = current + text.slice(0, Math.max(0, available));
        if (target === "stdout") stdout = bounded;
        else stderr = bounded;
      };

      child.stdout?.on("data", chunk => capture("stdout", Buffer.from(chunk)));
      child.stderr?.on("data", chunk => capture("stderr", Buffer.from(chunk)));

      const stopTree = () => {
        if (!child.pid) return;
        if (platform === "win32") {
          execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
            child.kill();
          });
        } else {
          try {
            killProcess(-child.pid, "SIGTERM");
          } catch {
            child.kill();
          }
        }
      };

      const signal = extra.signal;
      const abort = () => {
        cancelled = true;
        stopTree();
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });

      const runMonitor = setInterval(() => {
        if (currentRun(context) !== runId) abort();
      }, 250);
      const timeout = setTimeout(() => {
        timedOut = true;
        abort();
      }, MAX_CHECK_RUNTIME_MS);

      const outcome = await new Promise<{ exitCode: number | null; processSignal: string | null; error?: string }>(resolve => {
        child.once("error", error => {
          if (settled) return;
          settled = true;
          resolve({ exitCode: null, processSignal: null, error: error.message });
        });
        child.once("close", (exitCode, processSignal) => {
          if (settled) return;
          settled = true;
          resolve({ exitCode, processSignal });
        });
      });

      clearInterval(runMonitor);
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);

      return result({
        status: outcome.error ? "error" : timedOut ? "timed_out" : cancelled ? "cancelled" : "completed",
        checkId,
        exitCode: outcome.exitCode,
        signal: outcome.processSignal,
        stdout,
        stderr,
        outputTruncated,
        ...(outcome.error ? { message: outcome.error } : {})
      }, Boolean(outcome.error));
    }
  );
}
// Registers only tools that are implemented for the local ForgeLens MCP connector.
export function registerForgeLensTools(
  server: McpServer,
  context: ForgeLensToolContext
): void {
  registerSearchTextTool(server, context);
  registerFindSymbolTool(server, context);
  registerReadRangeTool(server, context);
  registerProposeEditTool(server, context);
  registerApproveHunkTool(server, context);
  registerRunCheckTool(server, context);
}
