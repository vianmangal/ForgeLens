import * as vscode from "vscode";
import type { ContextRow } from "../shared/types";
import { RunContextBudget } from "./budget";
import { findSymbol } from "./symbols";

interface MentionSource {
  path: string;
  startLine: number;
  endLine: number;
  lines: string[];
  truncated?: boolean;
}

interface PreparedMentionInput {
  instruction: string;
  contextRows: ContextRow[];
  state: MentionPreparationState;
}

interface MentionEntry {
  kind: "file" | "symbol";
  query: string;
  source: MentionSource;
}

export interface MentionPreparationState {
  entries: MentionEntry[];
}

const MAX_MENTION_FILE_BYTES = 200_000;
const MAX_MENTION_LINES = 300;
const encoder = new TextEncoder();

// Opens a workspace file while rejecting parent paths and symlink traversal.
async function openMentionDocument(path: string): Promise<vscode.TextDocument> {
  const folders = vscode.workspace.workspaceFolders;
  if (!vscode.workspace.isTrusted || folders?.length !== 1) {
    throw new Error("Open one trusted workspace folder before using file mentions.");
  }

  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(segment => segment && segment !== ".");
  if (!normalized || !segments.length || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || segments.includes("..")) {
    throw new Error("Use a workspace-relative @file(path) mention without '..'.");
  }

  let uri = folders[0].uri;
  for (let index = 0; index < segments.length; index += 1) {
    uri = vscode.Uri.joinPath(uri, segments[index]);
    const stat = await vscode.workspace.fs.stat(uri);
    const isLastSegment = index === segments.length - 1;
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0 ||
      (isLastSegment ? (stat.type & vscode.FileType.File) === 0 : (stat.type & vscode.FileType.Directory) === 0)) {
      throw new Error("@file mentions must point to a regular file without symbolic links.");
    }
    if (isLastSegment && stat.size > MAX_MENTION_FILE_BYTES) {
      throw new Error(`@file mentions are limited to ${MAX_MENTION_FILE_BYTES} bytes per file.`);
    }
  }

  const document = await vscode.workspace.openTextDocument(uri);
  if (encoder.encode(document.getText()).byteLength > MAX_MENTION_FILE_BYTES) {
    throw new Error(`@file mentions are limited to ${MAX_MENTION_FILE_BYTES} bytes per file.`);
  }
  return document;
}

// Resolves a symbol mention and asks the developer when its name is ambiguous.
async function resolveSymbolMention(name: string, runId: string, signal: AbortSignal): Promise<MentionSource> {
  const lookup = await findSymbol(name, new RunContextBudget(`${runId}:mention-lookup`, 1_000_000));
  if (signal.aborted) throw new Error("Mention loading was cancelled.");
  const exact = lookup.results.filter(result => result.name.toLowerCase() === name.toLowerCase());
  const candidates = exact.length ? exact : lookup.results;
  if (!candidates.length) {
    throw new Error(`Could not find symbol "${name}". Check its spelling or use @file(path).`);
  }

  const selected = candidates.length === 1 && exact.length === 1
    ? candidates[0]
    : await chooseSymbol(candidates, name, signal);
  if (!selected) throw new Error(`No symbol was selected for @symbol(${name}).`);

  let current = selected;
  let document = await openMentionDocument(current.path);
  if (signal.aborted) throw new Error("Mention loading was cancelled.");
  if (!symbolExistsInRange(document, current, name)) {
    const refreshed = await findSymbol(name, new RunContextBudget(`${runId}:mention-refresh`, 1_000_000), current.path);
    const refreshedExact = refreshed.results.filter(result => result.name.toLowerCase() === name.toLowerCase());
    if (!refreshedExact.length) {
      throw new Error(`The location for "${name}" changed. Search for it again and choose its current location.`);
    }
    const confirmed = await chooseSymbol(refreshedExact, name, signal);
    if (!confirmed) throw new Error(`Choose the current location for @symbol(${name}) to continue.`);
    current = confirmed;
    document = await openMentionDocument(current.path);
    if (signal.aborted) throw new Error("Mention loading was cancelled.");
    if (!symbolExistsInRange(document, current, name)) {
      throw new Error(`The location for "${name}" changed again. Search for it again and choose its current location.`);
    }
  }
  const startLine = current.startLine;
  const endLine = current.endLine;
  const end = Math.min(endLine, startLine + MAX_MENTION_LINES - 1);
  return {
    path: vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/"),
    startLine,
    endLine: end,
    lines: document.getText().split(/\r?\n/).slice(startLine - 1, end),
    truncated: current.endLine > end
  };
}

// Verifies a provider's line range still contains the chosen identifier in the current buffer.
function symbolExistsInRange(document: vscode.TextDocument, symbol: { startLine: number; endLine: number }, name: string): boolean {
  if (symbol.startLine < 1 || symbol.endLine < symbol.startLine || symbol.endLine > document.lineCount) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`, "i");
  for (let line = symbol.startLine; line <= symbol.endLine; line += 1) {
    if (pattern.test(document.lineAt(line - 1).text)) return true;
  }
  return false;
}

// Keeps the symbol picker dismissible when the developer cancels the run.
function chooseSymbol(
  candidates: Awaited<ReturnType<typeof findSymbol>>["results"],
  name: string,
  signal: AbortSignal
): Promise<(typeof candidates)[number] | undefined> {
  const picker = vscode.window.createQuickPick<{ label: string; description: string; detail: string; candidate: (typeof candidates)[number] }>();
  picker.items = candidates.map(candidate => ({
    label: candidate.name,
    description: `${candidate.path}:${candidate.startLine}-${candidate.endLine}`,
    detail: candidate.evidence,
    candidate
  }));
  picker.placeholder = `Choose which "${name}" symbol to include`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (candidate?: (typeof candidates)[number], error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      picker.dispose();
      if (error) reject(error);
      else resolve(candidate);
    };
    const onAbort = () => finish(undefined, new Error("Mention loading was cancelled."));
    picker.onDidAccept(() => finish(picker.selectedItems[0]?.candidate));
    picker.onDidHide(() => finish());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else picker.show();
  });
}

// Charges whole source lines before adding each explicit mention to the first prompt.
export async function prepareMentionInput(
  instruction: string,
  budget: RunContextBudget,
  signal: AbortSignal,
  previousState?: unknown
): Promise<PreparedMentionInput> {
  const pattern = /@(file|symbol)\(([^)]+)\)/g;
  const matches = [...instruction.matchAll(pattern)];
  if (!matches.length) return { instruction, contextRows: [], state: { entries: [] } };

  const previousEntries = isMentionPreparationState(previousState) ? previousState.entries : [];
  const entries: MentionEntry[] = [];
  const contextRows: ContextRow[] = [];
  const output: string[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (signal.aborted) throw new Error("Mention loading was cancelled.");
    const kind = match[1] as "file" | "symbol";
    const query = kind === "file" ? match[2] : match[2].trim();
    if (!query) throw new Error(`Add a path or name inside @${kind}(...).`);

    output.push(instruction.slice(cursor, match.index));
    const previousEntry = previousEntries[entries.length];
    const carriedSource = previousEntry?.kind === kind && previousEntry.query === query
      ? previousEntry.source
      : undefined;
    const document = kind === "file" && !carriedSource ? await openMentionDocument(query) : undefined;
    const source = carriedSource ?? (document
      ? {
          path: vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/"),
          startLine: 1,
          endLine: Math.min(document.lineCount, MAX_MENTION_LINES),
          lines: document.getText().split(/\r?\n/).slice(0, MAX_MENTION_LINES),
          truncated: document.lineCount > MAX_MENTION_LINES
        }
      : await resolveSymbolMention(query, budget.runId, signal));
    if (signal.aborted) throw new Error("Mention loading was cancelled.");
    entries.push({ kind, query, source });
    const reservation = reserveMention(kind, query, source, budget);
    const { row } = reservation;
    contextRows.push(row);

    if (row.exclusion === "duplicate") {
      output.push(`[${match[0]} was already included earlier in this run.]`);
    } else if (!row.sentToModel) {
      output.push(`[${match[0]} was not included: ${row.exclusion ?? "budget exhausted"}.]`);
    } else {
      output.push(`[Explicit ${kind} context: ${source.path}:${row.startLine}-${row.endLine}]\n${reservation.text}`);
      if (row.exclusion === "truncated") output.push("\n[Additional lines were omitted to fit the context budget.]");
    }
    cursor = match.index + match[0].length;
  }

  output.push(instruction.slice(cursor));
  return { instruction: output.join(""), contextRows, state: { entries } };
}

function isMentionPreparationState(value: unknown): value is MentionPreparationState {
  return typeof value === "object" && value !== null && "entries" in value && Array.isArray(value.entries) &&
    value.entries.every(entry => typeof entry === "object" && entry !== null &&
      (entry.kind === "file" || entry.kind === "symbol") && typeof entry.query === "string" &&
      typeof entry.source === "object" && entry.source !== null && typeof entry.source.path === "string" &&
      Array.isArray(entry.source.lines));
}

function reserveMention(
  kind: "file" | "symbol",
  query: string,
  source: MentionSource,
  budget: RunContextBudget
): { row: ContextRow; text: string } {
  const selected: string[] = [];
  let truncated = source.truncated ?? false;

  for (let index = 0; index < source.lines.length; index += 1) {
    const line = `${source.startLine + index}: ${source.lines[index]}`;
    const candidateLines = [...selected, line];
    const candidateEndLine = source.startLine + candidateLines.length - 1;
    const candidateContent = JSON.stringify({
      path: source.path,
      startLine: source.startLine,
      endLine: candidateEndLine,
      text: candidateLines.join("\n")
    });
    if (Math.ceil(encoder.encode(candidateContent).byteLength / 4) > budget.remainingTokens) {
      truncated = true;
      break;
    }
    selected.push(line);
  }

  const endLine = selected.length ? source.startLine + selected.length - 1 : source.startLine;
  if (!selected.length) {
    return {
      row: budget.recordOverBudget({
        tool: "mention",
        query: `@${kind}(${query})`,
        path: source.path,
        startLine: source.startLine,
        endLine,
        signal: "explicit_mention",
        content: ""
      }),
      text: ""
    };
  }
  const text = selected.join("\n");
  const row = budget.reserve({
    tool: "mention",
    query: `@${kind}(${query})`,
    path: source.path,
    startLine: source.startLine,
    endLine,
    signal: "explicit_mention",
    content: JSON.stringify({
      path: source.path,
      startLine: source.startLine,
      endLine,
      text
    }),
    truncated
  });
  return { row, text };
}
