import * as vscode from "vscode";
import ignore from "ignore";
import type { ContextRow } from "../shared/types";
import type { RunContextBudget } from "./budget";

export interface SearchResult {
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  signal: "identifier_match" | "text_match";
  truncated: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  contextRows: ContextRow[];
  truncated: boolean;
  budgetExhausted: boolean;
  status: "ok" | "budget_exhausted";
}

interface IgnoreRule {
  directory: string;
  matcher: ReturnType<typeof ignore>;
}

interface SearchCandidate {
  result: SearchResult;
}

export interface SearchExecutionOptions {
  tool?: "search_text" | "find_symbol";
  signal?: ContextRow["signal"];
  pattern?: RegExp;
  pathHint?: string;
  maxTimeMs?: number;
}

const MAX_RESULTS = 30;
const MAX_FILES_TO_SCAN = 1200;
const MAX_FILE_BYTES = 200_000;
const MAX_SEARCH_TIME_MS = 2500;
const MAX_EXCERPT_LENGTH = 400;
const MAX_CANDIDATES_PER_SIGNAL = 250;

const EXCLUDED_DIRECTORIES = new Set([
  ".venv",
  "venv",
  "site-packages",
  "node_modules",
  ".git",
  "pycache",
  "__pycache__",
  "dist",
  "build"
]);

const decoder = new TextDecoder("utf-8");

// Gets the one trusted workspace folder that this search may inspect.
function getWorkspaceRoot(): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders;

  if (!vscode.workspace.isTrusted || folders?.length !== 1) {
    throw new Error("Open one trusted workspace folder before searching.");
  }

  return folders[0].uri;
}

// Rejects absolute paths and parent-directory segments in the optional scope.
function normalizeScope(scope?: string): string[] {
  if (!scope?.trim()) {
    return [];
  }

  const normalized = scope.trim().replace(/\\/g, "/");

  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("Search scope must be a relative path inside the workspace.");
  }

  return normalized
    .split("/")
    .filter(segment => segment.length > 0 && segment !== ".");
}

// Confirms that a URI is still inside the selected workspace folder.
function isInsideWorkspace(root: vscode.Uri, target: vscode.Uri): boolean {
  if (root.scheme !== target.scheme || root.authority !== target.authority) {
    return false;
  }

  const rootPath = root.path.replace(/\/+$/, "");
  return target.path === rootPath || target.path.startsWith(`${rootPath}/`);
}

// Converts a workspace-relative path to the forward-slash form used in results.
function toRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

// Compares strings by code point so result ordering does not depend on locale.
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Applies a folder's .gitignore rules to a workspace-relative path.
function isIgnored(
  relativePath: string,
  isDirectory: boolean,
  rules: IgnoreRule[]
): boolean {
  let ignored = false;

  for (const rule of rules) {
    let pathFromRule = relativePath;

    if (rule.directory) {
      if (relativePath === rule.directory) {
        pathFromRule = "";
      } else if (relativePath.startsWith(`${rule.directory}/`)) {
        pathFromRule = relativePath.slice(rule.directory.length + 1);
      } else {
        continue;
      }
    }

    if (!pathFromRule) {
      continue;
    }

    const checkedPath = isDirectory ? `${pathFromRule}/` : pathFromRule;
    const result = rule.matcher.test(checkedPath);

    if (result.ignored) {
      ignored = true;
    } else if (result.unignored) {
      ignored = false;
    }
  }

  return ignored;
}

// Reads .gitignore rules; fails safely if an existing ignore file cannot be read.
async function readIgnoreRule(
  directoryUri: vscode.Uri,
  relativeDirectory: string
): Promise<IgnoreRule | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(directoryUri, ".gitignore")
    );

    return {
      directory: relativeDirectory,
      matcher: ignore().add(decoder.decode(bytes))
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FileNotFound"
    ) {
      return undefined;
    }

    throw new Error(
      `Could not read .gitignore in "${relativeDirectory || "."}".`
    );
  }
}

// Creates a short excerpt around the match and marks it if the line was clipped.
function makeExcerpt(line: string, query: string): {
  excerpt: string;
  truncated: boolean;
} {
  if (line.length <= MAX_EXCERPT_LENGTH) {
    return { excerpt: line, truncated: false };
  }

  const matchIndex = line.toLowerCase().indexOf(query.toLowerCase());
  const spareLength = MAX_EXCERPT_LENGTH - query.length;
  const beforeMatch = Math.floor(spareLength / 2);
  const start = Math.max(
    0,
    Math.min(matchIndex - beforeMatch, line.length - MAX_EXCERPT_LENGTH)
  );
  const end = start + MAX_EXCERPT_LENGTH;

  return {
    excerpt: `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`,
    truncated: true
  };
}

// Escapes query characters so symbol names can be checked as literal identifiers.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Identifies a whole identifier match, rather than a match inside a longer word.
function isIdentifierMatch(
  line: string,
  query: string,
  identifierPattern: RegExp
): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(query) &&
    identifierPattern.test(line);
}

// Searches bounded text files, ranks identifier matches first, and reserves budget.
export async function searchText(
  query: string,
  budget: RunContextBudget,
  scope?: string,
  requestedLimit = 10,
  options: SearchExecutionOptions = {}
): Promise<SearchResponse> {
  const cleanQuery = query.trim();

  if (!cleanQuery) {
    throw new Error("Search query cannot be empty.");
  }

  if (cleanQuery.length > 256) {
    throw new Error("Search query must be 256 characters or fewer.");
  }

  const limit = Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, MAX_RESULTS))
    : 10;

  const workspaceRoot = getWorkspaceRoot();
  const scopeSegments = normalizeScope(scope);
  const pathHint = options.pathHint?.trim().replace(/\\/g, "/").toLowerCase();

  if (
    pathHint &&
    (pathHint.startsWith("/") || /^[A-Za-z]:/.test(pathHint) || pathHint.split("/").includes(".."))
  ) {
    throw new Error("Path hint must be a relative path inside the workspace.");
  }

  let searchRoot = workspaceRoot;
  let searchRootRelative = "";
  let parentRules: IgnoreRule[] = [];

  for (const segment of scopeSegments) {
    if (EXCLUDED_DIRECTORIES.has(segment.toLowerCase())) {
      throw new Error(`Search scope uses an excluded folder: ${segment}`);
    }

    const rule = await readIgnoreRule(searchRoot, searchRootRelative);

    if (rule) {
      parentRules = [...parentRules, rule];
    }

    const childRelative = searchRootRelative
      ? `${searchRootRelative}/${segment}`
      : segment;

    if (isIgnored(childRelative, true, parentRules)) {
      throw new Error("Search scope is excluded by .gitignore.");
    }

    searchRoot = vscode.Uri.joinPath(searchRoot, segment);
    searchRootRelative = childRelative;
  }

  if (!isInsideWorkspace(workspaceRoot, searchRoot)) {
    throw new Error("Search scope must stay inside the workspace.");
  }

  let scopeInfo: vscode.FileStat;

  try {
    scopeInfo = await vscode.workspace.fs.stat(searchRoot);
  } catch {
    throw new Error("Search scope must be an existing workspace folder.");
  }

  if ((scopeInfo.type & vscode.FileType.Directory) === 0) {
    throw new Error("Search scope must be a folder.");
  }

  const identifierPattern = new RegExp(
    `(^|[^A-Za-z0-9_$])${escapeRegExp(cleanQuery)}(?=$|[^A-Za-z0-9_$])`,
    "i"
  );

  const identifierMatches: SearchCandidate[] = [];
  const textMatches: SearchCandidate[] = [];
  const deadline = Date.now() + Math.max(1, Math.min(options.maxTimeMs ?? MAX_SEARCH_TIME_MS, MAX_SEARCH_TIME_MS));
  let scannedFiles = 0;
  let truncated = false;

  // Walks folders in a stable order and stops when a scan limit is reached.
  async function walk(
    directoryUri: vscode.Uri,
    relativeDirectory: string,
    inheritedRules: IgnoreRule[]
  ): Promise<void> {
    if (Date.now() >= deadline || scannedFiles >= MAX_FILES_TO_SCAN) {
      truncated = true;
      return;
    }

    const localRule = await readIgnoreRule(directoryUri, relativeDirectory);
    const rules = localRule
      ? [...inheritedRules, localRule]
      : inheritedRules;

    let entries: [string, vscode.FileType][];

    try {
      entries = await vscode.workspace.fs.readDirectory(directoryUri);
    } catch {
      truncated = true;
      return;
    }

    entries.sort((left, right) => compareText(left[0], right[0]));

    for (const [name, fileType] of entries) {
      if (Date.now() >= deadline) {
        truncated = true;
        return;
      }

      if (name === ".gitignore") {
        continue;
      }

      if ((fileType & vscode.FileType.SymbolicLink) !== 0) {
        continue;
      }

      const isDirectory = (fileType & vscode.FileType.Directory) !== 0;
      const isFile = (fileType & vscode.FileType.File) !== 0;

      if (isDirectory && EXCLUDED_DIRECTORIES.has(name.toLowerCase())) {
        continue;
      }

      if (!isDirectory && !isFile) {
        continue;
      }

      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;

      if (isIgnored(relativePath, isDirectory, rules)) {
        continue;
      }

      const childUri = vscode.Uri.joinPath(directoryUri, name);

      if (isDirectory) {
        await walk(childUri, relativePath, rules);
        continue;
      }

      if (scannedFiles >= MAX_FILES_TO_SCAN) {
        truncated = true;
        return;
      }

      scannedFiles += 1;

      let fileInfo: vscode.FileStat;

      try {
        fileInfo = await vscode.workspace.fs.stat(childUri);
      } catch {
        truncated = true;
        continue;
      }

      if (fileInfo.size > MAX_FILE_BYTES) {
        truncated = true;
        continue;
      }

      let bytes: Uint8Array;

      try {
        bytes = await vscode.workspace.fs.readFile(childUri);
      } catch {
        truncated = true;
        continue;
      }

      if (Date.now() >= deadline) {
        truncated = true;
        return;
      }

      if (bytes.includes(0)) {
        continue;
      }

      const lines = decoder.decode(bytes).split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        options.pattern && (options.pattern.lastIndex = 0);
        const lineMatches = options.pattern
          ? options.pattern.test(line)
          : line.toLowerCase().includes(cleanQuery.toLowerCase());

        if (!lineMatches) {
          continue;
        }

        const isIdentifier = isIdentifierMatch(
          line,
          cleanQuery,
          identifierPattern
        );
        const bucket = isIdentifier ? identifierMatches : textMatches;

        if (bucket.length >= MAX_CANDIDATES_PER_SIGNAL) {
          truncated = true;
          continue;
        }

        const excerpt = makeExcerpt(line, cleanQuery);
        const result: SearchResult = {
          path: toRelativePath(relativePath),
          startLine: index + 1,
          endLine: index + 1,
          excerpt: excerpt.excerpt,
          signal: isIdentifier ? "identifier_match" : "text_match",
          truncated: excerpt.truncated
        };

        bucket.push({ result });
      }
    }
  }

  await walk(searchRoot, searchRootRelative, parentRules);

  const candidates = [
    ...identifierMatches.map(candidate => candidate.result),
    ...textMatches.map(candidate => candidate.result)
  ];

  candidates.sort((left, right) => {
    if (pathHint) {
      const leftMatchesHint = left.path.toLowerCase().includes(pathHint);
      const rightMatchesHint = right.path.toLowerCase().includes(pathHint);

      if (leftMatchesHint !== rightMatchesHint) {
        return leftMatchesHint ? -1 : 1;
      }
    }

    if (left.signal !== right.signal) {
      return left.signal === "identifier_match" ? -1 : 1;
    }

    return compareText(left.path, right.path) ||
      left.startLine - right.startLine;
  });

  const results: SearchResult[] = [];
  const contextRows: ContextRow[] = [];
  let budgetExhausted = false;

  for (const result of candidates) {
    if (results.length >= limit) {
      truncated = true;
      break;
    }

    const row = budget.reserve({
      tool: options.tool ?? "search_text",
      query: cleanQuery,
      path: result.path,
      startLine: result.startLine,
      endLine: result.endLine,
      signal: options.signal ?? result.signal,
      content: JSON.stringify(result),
      truncated: result.truncated
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

    if (result.truncated) {
      truncated = true;
    }
  }

  return {
    results,
    contextRows,
    truncated,
    budgetExhausted,
    status: budgetExhausted && results.length === 0
      ? "budget_exhausted"
      : "ok"
  };
}
