import * as vscode from "vscode";
import * as z from "zod/v4";
import { execFile, spawn } from "node:child_process";
import { kill as killProcess, platform } from "node:process";
import { RunContextBudget } from "../context/budget";
import { findSymbol } from "../context/symbols";
import { searchText } from "../context/search";
import type { ContextRow, SourceSnapshot } from "../shared/types";
import type { ReviewApi } from "../review";
import { hashText, type ProposalRequest } from "../review/hunks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type CurrentRunId = () => string | undefined;

export interface ForgeLensToolContext {
  review: ReviewApi;
  currentRunId: CurrentRunId;
  isRunActive: (runId: string) => boolean;
  registerProposed: (runId: string, hunkId: string) => boolean;
  onContextRows?: (runId: string, rows: ContextRow[]) => void;
}

const budgetsByRun = new Map<string, RunContextBudget>();
const snapshotsByRun = new Map<string, Set<string>>();
const encoder = new TextEncoder();
export const DEFAULT_CONTEXT_BUDGET = 6000;
export const MAX_READ_LINES = 300;
const DECISION_WAIT_MS = 15_000;
const MAX_CHECK_OUTPUT_CHARS = 16_000;
const MAX_CHECK_RUNTIME_MS = 120_000;
const CHECK_KILL_GRACE_MS = 1_000;
const CHECK_CLOSE_GRACE_MS = 500;

// Reuses one context ledger per run so concurrent retrieval calls share its budget.
export function getBudgetForRun(runId: string): RunContextBudget {
  let budget = budgetsByRun.get(runId);

  if (!budget) {
    const configured = vscode.workspace
      .getConfiguration("forgelens")
      .get<unknown>("contextBudget", DEFAULT_CONTEXT_BUDGET);
    const limitTokens = typeof configured === "number" && Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_CONTEXT_BUDGET;

    budget = new RunContextBudget(runId, limitTokens);
    budgetsByRun.set(runId, budget);
  }

  return budget;
}

// Drops the run's ledger once ForgeLens no longer needs its retrieval history.
export function clearBudgetForRun(runId: string): void {
  budgetsByRun.delete(runId);
  snapshotsByRun.delete(runId);
}

function issueSnapshot(runId: string, snapshotId: string): void {
  let issued = snapshotsByRun.get(runId);
  if (!issued) {
    issued = new Set();
    snapshotsByRun.set(runId, issued);
  }
  issued.add(snapshotId);
}

function waitForDecision(context: ForgeLensToolContext, runId: string, hunkId: string, signal: AbortSignal): Promise<void> {
  const settled = () => {
    const hunk = context.review.store.getHunk(hunkId);
    return !context.isRunActive(runId) || !hunk || (hunk.status !== "proposed" && hunk.status !== "approval_requested") ||
      context.review.store.queuedDecision(hunkId) === "accepted";
  };
  if (settled() || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      clearInterval(monitor);
      subscription.dispose();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const subscription = context.review.store.onDidChange(() => { if (settled()) finish(); });
    const monitor = setInterval(() => { if (settled()) finish(); }, 250);
    const timer = setTimeout(finish, DECISION_WAIT_MS);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function result(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {})
  };
}

function currentRun(context: ForgeLensToolContext): string | undefined {
  const runId = context.currentRunId();
  return runId && context.isRunActive(runId) && context.review.store.getRun(runId)?.active ? runId : undefined;
}

// Resolves a relative file path only inside the single trusted workspace.
async function resolveWorkspaceDocument(path: string): Promise<vscode.TextDocument> {
  const folders = vscode.workspace.workspaceFolders;
  if (!vscode.workspace.isTrusted || folders?.length !== 1) {
    throw new Error("Open one trusted workspace folder before reading files.");
  }

  const normalized = path.replace(/\\/g, "/");
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
      description: "Search the workspace for a literal, case-insensitive query. Results are ranked definitions first, then whole-identifier matches, then plain text, and return one-line excerpts with 1-based line numbers. Ignored, dependency and generated folders are skipped. Each excerpt is charged to the run's context budget.",
      inputSchema: {
        query: z.string().min(1).max(256).describe("Literal text or identifier to find."),
        scope: z.string().max(1024).optional().describe("Optional workspace-relative folder to search, for example a source or test folder."),
        limit: z.number().int().min(1).max(30).optional().describe("Maximum number of excerpts to return; defaults to 10.")
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query, scope, limit }) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);

      try {
        const response = await searchText(query, getBudgetForRun(runId), scope, limit ?? 10);
        if (!context.isRunActive(runId)) return result({ status: "cancelled", message: "The run ended during workspace search." });
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
      description: "Find definitions of a function, class, method or variable by name. Uses the editor's symbol provider and falls back to a bounded lexical search. Returns path, 1-based line range and evidence for each candidate.",
      inputSchema: {
        name: z.string().min(1).max(256).describe("Identifier to look up."),
        pathHint: z.string().max(512).optional().describe("Optional workspace-relative path fragment that the definition's file must contain.")
      },
      annotations: { readOnlyHint: true }
    },
    async ({ name, pathHint }) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);

      try {
        const response = await findSymbol(name, getBudgetForRun(runId), pathHint);
        if (!context.isRunActive(runId)) return result({ status: "cancelled", message: "The run ended during symbol lookup." });
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
      description: `Read numbered lines from a workspace file, including unsaved editor changes. Lines are 1-based and inclusive. Ranges past the end of the file or longer than ${MAX_READ_LINES} lines are shortened, and the remaining context budget can shorten them further; truncated reports this. Returns the snapshotId that propose_edit needs for this file.`,
      inputSchema: {
        path: z.string().min(1).max(1024).describe("Workspace-relative file path as returned by search_text or find_symbol."),
        startLine: z.number().int().min(1).describe("First line to read, 1-based."),
        endLine: z.number().int().min(1).describe("Last line to read, 1-based and inclusive.")
      },
      annotations: { readOnlyHint: true }
    },
    async ({ path, startLine, endLine }) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);

      try {
        if (endLine < startLine) {
          throw new Error("endLine must be greater than or equal to startLine.");
        }

        const document = await resolveWorkspaceDocument(path);
        if (currentRun(context) !== runId) {
          return result({ status: "cancelled", message: "The run ended while the file was opening." });
        }
        if (startLine > document.lineCount) {
          throw new Error(`Requested lines ${startLine}-${endLine}, but the file has ${document.lineCount} lines.`);
        }
        const lastLine = Math.min(endLine, document.lineCount, startLine + MAX_READ_LINES - 1);
        const totalLines = document.lineCount;

        const snapshotRecord = context.review.store.captureSnapshot(document);
        const snapshot: SourceSnapshot = {
          snapshotId: snapshotRecord.snapshotId,
          path: snapshotRecord.path.replace(/\\/g, "/"),
          documentVersion: snapshotRecord.documentVersion,
          contentHash: snapshotRecord.contentHash
        };
        issueSnapshot(runId, snapshot.snapshotId);
        const budget = getBudgetForRun(runId);
        const sourceLines = document.getText().split(/\r?\n/);
        const selected: string[] = [];
        let truncated = false;

        for (let lineNumber = startLine; lineNumber <= lastLine; lineNumber += 1) {
          const numberedLine = `${lineNumber}: ${sourceLines[lineNumber - 1] ?? ""}`;
          const candidateText = [...selected, numberedLine].join("\n");
          const candidateEndLine = startLine + selected.length;
          const candidatePayload = {
            path: snapshot.path,
            startLine,
            endLine: candidateEndLine,
            totalLines,
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
          totalLines,
          text,
          snapshot,
          snapshotId: snapshot.snapshotId
        });
        if (!selected.length) {
          const row = budget.recordOverBudget({
            tool: "read_range",
            query: `${snapshot.path}:${startLine}-${endLine}`,
            path: snapshot.path,
            startLine,
            endLine: actualEndLine,
            signal: "path_match",
            content
          });
          context.onContextRows?.(runId, [row]);
          return result({
            status: "budget_exhausted",
            message: "No complete source line fits in the remaining context budget.",
            path: snapshot.path,
            snapshot,
            contextRows: [row],
            truncated: true
          });
        }
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

        if (row.exclusion === "duplicate") {
          return result({
            status: "already_provided",
            message: "This source range was already provided earlier in the run.",
            path: snapshot.path,
            snapshot,
            contextRows: [row],
            truncated: true
          });
        }

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
          totalLines,
          text,
          snapshot,
          snapshotId: snapshot.snapshotId,
          contextRows: [row],
          truncated: truncated || actualEndLine < endLine
        });
      } catch (error) {
        if (!context.isRunActive(runId)) return result({ status: "cancelled", message: "The run ended while the file was opening." });
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
      description: "Stage an edit to one file for the developer's review; it never writes files. Pass the snapshotId that read_range returned for the file in this run and either startLine/endLine (1-based, inclusive; use endLine = startLine - 1 to insert before startLine) or a unique oldText copied exactly from the file. Returns the hunkIds to pass to approve_hunk. Stale, ambiguous or overlapping edits are rejected with an explanation.",
      inputSchema: {
        snapshotId: z.string().min(1).max(128).describe("snapshotId returned by read_range for this file in this run."),
        startLine: z.number().int().min(1).optional().describe("First line to replace, 1-based. Use with endLine instead of oldText."),
        endLine: z.number().int().min(0).optional().describe("Last line to replace, 1-based and inclusive. Use startLine - 1 to insert without replacing."),
        oldText: z.string().min(1).max(6_000).optional().describe("Exact existing text that occurs once in the file. Use instead of startLine/endLine."),
        newText: z.string().max(6_000).describe("Replacement text for the range or the oldText anchor.")
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

      if (!snapshotsByRun.get(runId)?.has(snapshotId)) {
        return result({ status: "error", message: "This snapshotId was not returned by read_range in the current run. Call read_range on the file and use the snapshotId it returns." }, true);
      }
      const snapshot = context.review.store.getSnapshot(snapshotId);
      if (snapshot) {
        let current: vscode.TextDocument;
        try {
          current = await vscode.workspace.openTextDocument(snapshot.uri);
        } catch {
          return result({ status: "error", message: `${snapshot.path} can no longer be opened. Search for the file again.` }, true);
        }
        if (currentRun(context) !== runId) return result({ status: "cancelled", message: "The run ended before the edit was staged." });
        if (current.version !== snapshot.documentVersion || hashText(current.getText()) !== snapshot.contentHash) {
          return result({ status: "error", message: `${snapshot.path} changed after this snapshot was read. Call read_range again and propose against the new snapshotId.` }, true);
        }
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
      description: "Ask the developer to accept or reject one hunk returned by propose_edit. Call it exactly once per hunkId and wait for the result. A rejection is final for that change. Accepted hunks are applied by the developer in the editor.",
      inputSchema: { hunkId: z.string().min(1).max(128).describe("One hunkId returned by propose_edit in this run.") }
    },
    async ({ hunkId }, extra) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);

      const owned = context.review.store.getHunk(hunkId);
      if (!owned || owned.runId !== runId) {
        return result({ status: "error", message: "This hunk does not belong to the current run." }, true);
      }
      await waitForDecision(context, runId, hunkId, extra.signal);
      const hunk = context.review.store.getHunk(hunkId);
      if (!hunk || currentRun(context) !== runId || hunk.status === "invalidated") {
        return result({ status: "cancelled", hunkId, message: "The run ended before this hunk was decided." });
      }
      if (hunk.status === "accepted" || (hunk.status === "approval_requested" && context.review.store.queuedDecision(hunkId) === "accepted")) {
        return result({ status: "accepted", hunkId, message: "The developer accepted this hunk. It is applied together with the other accepted hunks when the developer chooses Apply." });
      }
      if (hunk.status === "rejected") {
        return result({ status: "rejected", hunkId, message: "The developer rejected this hunk. The decision is final; do not propose the same change again." });
      }
      if (hunk.status !== "proposed" && hunk.status !== "approval_requested") {
        return result({ status: hunk.status, hunkId });
      }
      return result({ status: "pending", hunkId, message: "The developer has not decided yet. Do not call approve_hunk again for this hunk." });
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
      description: "Run one check profile configured by the developer, such as a test suite, in the workspace root with its configured Python executable and arguments. Returns the command, working directory, exit code and bounded stdout/stderr. Run it only after the developer has applied and saved the accepted edits; an earlier run is only a baseline.",
      inputSchema: { checkId: z.string().min(1).max(128).describe("ID of a configured check profile.") }
    },
    async ({ checkId }, extra) => {
      const runId = currentRun(context);
      if (!runId) return result({ status: "no_active_run", message: "There is no active ForgeLens run." }, true);
      if (extra.signal.aborted) return result({ status: "cancelled", message: "The run was cancelled before the check started." });

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

      const cwd = folders[0].uri.fsPath;
      const command = [pythonPath, ...profile.args];
      const child = spawn(pythonPath, profile.args, {
        cwd,
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
      let stopRequested = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let runMonitor: ReturnType<typeof setInterval> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let resolveOutcome: ((outcome: { exitCode: number | null; processSignal: string | null; error?: string }) => void) | undefined;

      const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
        if (settled) return;
        const text = chunk.toString("utf8");
        const current = target === "stdout" ? stdout : stderr;
        const available = MAX_CHECK_OUTPUT_CHARS - current.length;
        if (text.length > available) outputTruncated = true;
        const bounded = current + text.slice(0, Math.max(0, available));
        if (target === "stdout") stdout = bounded;
        else stderr = bounded;
      };

      const onStdout = (chunk: Buffer) => capture("stdout", Buffer.from(chunk));
      const onStderr = (chunk: Buffer) => capture("stderr", Buffer.from(chunk));
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);

      const killTree = (force: boolean) => {
        if (!child.pid) return;
        if (platform === "win32") {
          execFile("taskkill", ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
            windowsHide: true,
            timeout: CHECK_KILL_GRACE_MS
          }, () => {
            child.kill(force ? "SIGKILL" : "SIGTERM");
          });
        } else {
          try {
            killProcess(-child.pid, force ? "SIGKILL" : "SIGTERM");
          } catch {
            child.kill(force ? "SIGKILL" : "SIGTERM");
          }
        }
      };

      const signal = extra.signal;
      const outcomePromise = new Promise<{ exitCode: number | null; processSignal: string | null; error?: string }>(resolve => {
        resolveOutcome = resolve;
      });
      const finish = (outcome: { exitCode: number | null; processSignal: string | null; error?: string }) => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (runMonitor) clearInterval(runMonitor);
        if (timeout) clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
        if (outcome.error) {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        resolveOutcome?.(outcome);
      };
      const stopTree = () => {
        if (stopRequested || settled) return;
        stopRequested = true;
        killTree(false);
        forceTimer = setTimeout(() => {
          killTree(true);
          hardTimer = setTimeout(() => finish({
            exitCode: null,
            processSignal: null,
            error: "The child did not report closure after forced termination."
          }), CHECK_CLOSE_GRACE_MS);
        }, CHECK_KILL_GRACE_MS);
      };
      const abort = () => {
        cancelled = true;
        stopTree();
      };
      child.once("error", error => finish({ exitCode: null, processSignal: null, error: error.message }));
      child.once("close", (exitCode, processSignal) => finish({ exitCode, processSignal }));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });

      runMonitor = setInterval(() => {
        if (!context.isRunActive(runId)) abort();
      }, 250);
      timeout = setTimeout(() => {
        timedOut = true;
        abort();
      }, MAX_CHECK_RUNTIME_MS);

      const outcome = await outcomePromise;
      if (!context.isRunActive(runId)) cancelled = true;

      return result({
        status: timedOut ? "timed_out" : cancelled ? "cancelled" : outcome.error ? "error" : "completed",
        checkId,
        command,
        cwd,
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
