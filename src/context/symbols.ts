import * as vscode from "vscode";
import type { ContextRow } from "../shared/types";
import type { RunContextBudget } from "./budget";
import { searchText } from "./search";

export interface SymbolResult {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  evidence: string;
}

export interface FindSymbolResponse {
  results: SymbolResult[];
  contextRows: ContextRow[];
  truncated: boolean;
  budgetExhausted: boolean;
  source: "workspace_provider" | "regex_fallback";
  status: "ok" | "budget_exhausted";
}

interface WorkspaceSymbolLookup {
  symbols: vscode.SymbolInformation[];
  timedOut: boolean;
}

// Converts the provider's URI to a safe, forward-slash workspace path.
function workspacePath(uri: vscode.Uri): string | undefined {
  const relativePath = vscode.workspace
    .asRelativePath(uri, false)
    .replace(/\\/g, "/");

  if (
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.split("/").includes("..")
  ) {
    return undefined;
  }

  return relativePath;
}

// Returns no results if the provider takes longer than two seconds.
async function getWorkspaceSymbols(
  name: string
): Promise<WorkspaceSymbolLookup> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(undefined);
    }, 2000);
  });

  try {
    const symbols = await Promise.race([
      vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        name
      ),
      timeout
    ]);

    return {
      symbols: Array.isArray(symbols) ? symbols : [],
      timedOut
    };
  } catch {
    return { symbols: [], timedOut };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// Finds symbols through VS Code first, then uses the bounded regex search fallback.
export async function findSymbol(
  name: string,
  budget: RunContextBudget,
  pathHint?: string
): Promise<FindSymbolResponse> {
  const cleanName = name.trim();

  if (!cleanName) {
    throw new Error("Symbol name cannot be empty.");
  }

  if (!vscode.workspace.isTrusted || vscode.workspace.workspaceFolders?.length !== 1) {
    throw new Error("Open one trusted workspace folder before finding symbols.");
  }

  const cleanHint = pathHint?.trim().replace(/\\/g, "/").toLowerCase();

  if (
    cleanHint &&
    (cleanHint.startsWith("/") || /^[A-Za-z]:/.test(cleanHint) || cleanHint.split("/").includes(".."))
  ) {
    throw new Error("Path hint cannot contain a '..' segment.");
  }

  const lookup = await getWorkspaceSymbols(cleanName);
  const providerResults: SymbolResult[] = [];

  for (const symbol of lookup.symbols) {
    const filePath = workspacePath(symbol.location.uri);

    if (!filePath) {
      continue;
    }

    if (cleanHint && !filePath.toLowerCase().includes(cleanHint)) {
      continue;
    }

    const startLine = symbol.location.range.start.line + 1;
    const endLine = Math.max(
      startLine,
      symbol.location.range.end.line + 1
    );
    const kind = vscode.SymbolKind[symbol.kind] ?? "symbol";

    providerResults.push({
      name: symbol.name,
      kind,
      path: filePath,
      startLine,
      endLine,
      evidence: `${kind} ${symbol.name}${symbol.containerName ? ` in ${symbol.containerName}` : ""}`
    });
  }

  providerResults.sort((left, right) =>
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) ||
    left.startLine - right.startLine ||
    (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  );

  if (providerResults.length > 0) {
    const results: SymbolResult[] = [];
    const contextRows: ContextRow[] = [];
    let truncated = lookup.timedOut || providerResults.length > 30;
    let budgetExhausted = false;

    for (const result of providerResults.slice(0, 30)) {
      const row = budget.reserve({
        tool: "find_symbol",
        query: cleanName,
        path: result.path,
        startLine: result.startLine,
        endLine: result.endLine,
        signal: "symbol_definition",
        content: JSON.stringify(result)
      });

      contextRows.push(row);

      if (row.exclusion === "duplicate") {
        truncated = true;
        continue;
      }

      if (!row.sentToModel) {
        budgetExhausted = true;
        truncated = true;
        break;
      }

      results.push(result);
    }

    return {
      results,
      contextRows,
      truncated,
      budgetExhausted,
      source: "workspace_provider",
      status: budgetExhausted && results.length === 0
        ? "budget_exhausted"
        : "ok"
    };
  }

  const escapedName = cleanName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_$])${escapedName}(?=$|[^A-Za-z0-9_$])`,
    "i"
  );
  const fallback = await searchText(cleanName, budget, undefined, 30, {
    tool: "find_symbol",
    signal: "identifier_match",
    pattern,
    pathHint: cleanHint,
    maxTimeMs: 2000
  });
  const results = fallback.results.map(result => ({
    name: cleanName,
    kind: "lexical match",
    path: result.path,
    startLine: result.startLine,
    endLine: result.endLine,
    evidence: `Regex fallback matched the identifier in: ${result.excerpt}`
  }));

  return {
    results,
    contextRows: fallback.contextRows,
    truncated: fallback.truncated || lookup.timedOut,
    budgetExhausted: fallback.budgetExhausted,
    source: "regex_fallback",
    status: fallback.status
  };
}
