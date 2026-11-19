import * as vscode from "vscode";
import { execFile } from "node:child_process";
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
  ignoreCase: boolean;
}

interface SearchCandidate {
  result: SearchResult;
}

export interface SearchExecutionOptions {
  tool?: "search_text" | "find_symbol";
  signal?: ContextRow["signal"];
  pattern?: RegExp;
  pathHint?: string;
  filterPathHint?: boolean;
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

class SearchDeadlineError extends Error {}

// Stops waiting for VS Code file-system providers when the search deadline passes.
async function beforeDeadline<T>(operation: PromiseLike<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SearchDeadlineError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SearchDeadlineError()), remaining);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Reads Git's local case-sensitivity setting without invoking a shell.
function repositoryIgnoreCase(root: vscode.Uri, deadline: number): Promise<boolean> {
  if (root.scheme !== "file") return Promise.resolve(false);
  const timeout = Math.max(1, deadline - Date.now());
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeout);
    execFile("git", ["config", "--local", "--bool", "--get", "core.ignoreCase"], {
      cwd: root.fsPath,
      timeout,
      windowsHide: true,
      maxBuffer: 4096
    }, (error, stdout) => finish(!error && stdout.trim().toLowerCase() === "true"));
  });
}

// Checks each descended directory for containment and symbolic links before reading it.
async function validateDirectory(root: vscode.Uri, target: vscode.Uri, deadline: number): Promise<void> {
  if (!isInsideWorkspace(root, target)) throw new Error("Search scope must stay inside the workspace.");
  const info = await beforeDeadline(vscode.workspace.fs.stat(target), deadline);
  if ((info.type & vscode.FileType.SymbolicLink) !== 0 || (info.type & vscode.FileType.Directory) === 0) {
    throw new Error("Search scope must be a directory without symbolic links.");
  }
}

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
  if (!scope) {
    return [];
  }

  const normalized = scope.replace(/\\/g, "/");

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
    const checkedRelative = rule.ignoreCase ? relativePath.toLowerCase() : relativePath;
    const checkedDirectory = rule.ignoreCase ? rule.directory.toLowerCase() : rule.directory;

    if (rule.directory) {
      if (checkedRelative === checkedDirectory) {
        pathFromRule = "";
      } else if (checkedRelative.startsWith(`${checkedDirectory}/`)) {
        pathFromRule = relativePath.slice(rule.directory.length + 1);
      } else {
        continue;
      }
    }

    if (!pathFromRule) {
      continue;
    }

    const checkedPath = isDirectory ? `${pathFromRule}/` : pathFromRule;
    const result = rule.matcher.test(rule.ignoreCase ? checkedPath.toLowerCase() : checkedPath);

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
  relativeDirectory: string,
  ignoreCase: boolean,
  deadline: number
): Promise<IgnoreRule | undefined> {
  const ignoreUri = vscode.Uri.joinPath(directoryUri, ".gitignore");
  try {
    const info = await beforeDeadline(vscode.workspace.fs.stat(ignoreUri), deadline);
    if ((info.type & vscode.FileType.SymbolicLink) !== 0 || (info.type & vscode.FileType.File) === 0) return undefined;
    const bytes = await beforeDeadline(vscode.workspace.fs.readFile(ignoreUri), deadline);
    const contents = decoder.decode(bytes);

    return {
      directory: relativeDirectory,
      matcher: ignore().add(ignoreCase ? contents.toLowerCase() : contents),
      ignoreCase
    };
  } catch (error) {
    if (error instanceof SearchDeadlineError) throw error;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "FileNotFound" || error.code === "ENOENT")
    ) {
      return undefined;
    }

    throw new Error(
      `Could not read .gitignore in "${relativeDirectory || "."}".`
    );
  }
}

// Creates a short excerpt around the match and marks it if the line was clipped.
function makeExcerpt(line: string, query: string, matchIndex: number): {
  excerpt: string;
  truncated: boolean;
} {
  if (line.length <= MAX_EXCERPT_LENGTH) {
    return { excerpt: line, truncated: false };
  }

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
function identifierMatchOffset(
  line: string,
  query: string,
  identifierPattern: RegExp
): number | undefined {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(query)) return undefined;
  identifierPattern.lastIndex = 0;
  const match = identifierPattern.exec(line);
  return match ? match.index + (match[1]?.length ?? 0) : undefined;
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
  const pathHint = options.pathHint?.replace(/\\/g, "/").toLowerCase();
  const deadline = Date.now() + Math.max(1, Math.min(options.maxTimeMs ?? MAX_SEARCH_TIME_MS, MAX_SEARCH_TIME_MS));

  if (
    pathHint &&
    (pathHint.startsWith("/") || /^[A-Za-z]:/.test(pathHint) || pathHint.split("/").includes(".."))
  ) {
    throw new Error("Path hint must be a relative path inside the workspace.");
  }

  let searchRoot = workspaceRoot;
  let searchRootRelative = "";
  let parentRules: IgnoreRule[] = [];
  let ignoreCase = false;
  try {
    ignoreCase = await repositoryIgnoreCase(workspaceRoot, deadline);
    await validateDirectory(workspaceRoot, workspaceRoot, deadline);

    for (const segment of scopeSegments) {
      if (EXCLUDED_DIRECTORIES.has(segment.toLowerCase())) {
        throw new Error(`Search scope uses an excluded folder: ${segment}`);
      }

      const rule = await readIgnoreRule(searchRoot, searchRootRelative, ignoreCase, deadline);
      if (rule) parentRules = [...parentRules, rule];

      const childRelative = searchRootRelative
        ? `${searchRootRelative}/${segment}`
        : segment;

      if (isIgnored(childRelative, true, parentRules)) {
        throw new Error("Search scope is excluded by .gitignore.");
      }

      const childUri = vscode.Uri.joinPath(searchRoot, segment);
      try {
        await validateDirectory(workspaceRoot, childUri, deadline);
      } catch (error) {
        if (error instanceof SearchDeadlineError) throw error;
        throw new Error("Search scope must be an existing workspace directory without symbolic links.");
      }
      searchRoot = childUri;
      searchRootRelative = childRelative;
    }
  } catch (error) {
    if (error instanceof SearchDeadlineError) {
      return { results: [], contextRows: [], truncated: true, budgetExhausted: false, status: "ok" };
    }
    throw error;
  }

  const identifierPattern = new RegExp(
    `(^|[^A-Za-z0-9_$])${escapeRegExp(cleanQuery)}(?=$|[^A-Za-z0-9_$])`,
    "i"
  );

  const identifierMatches: SearchCandidate[] = [];
  const textMatches: SearchCandidate[] = [];
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

    try {
      await validateDirectory(workspaceRoot, directoryUri, deadline);
    } catch (error) {
      truncated = true;
      return;
    }

    let localRule: IgnoreRule | undefined;
    try {
      localRule = await readIgnoreRule(directoryUri, relativeDirectory, ignoreCase, deadline);
    } catch (error) {
      if (error instanceof SearchDeadlineError) {
        truncated = true;
        return;
      }
      throw error;
    }
    const rules = localRule
      ? [...inheritedRules, localRule]
      : inheritedRules;

    let entries: [string, vscode.FileType][];

    try {
      entries = await beforeDeadline(vscode.workspace.fs.readDirectory(directoryUri), deadline);
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

      const resultPath = toRelativePath(relativePath);
      if (options.filterPathHint && pathHint && !resultPath.toLowerCase().includes(pathHint)) {
        continue;
      }

      if (scannedFiles >= MAX_FILES_TO_SCAN) {
        truncated = true;
        return;
      }

      scannedFiles += 1;

      let fileInfo: vscode.FileStat;

      try {
        if (!isInsideWorkspace(workspaceRoot, childUri)) {
          truncated = true;
          continue;
        }
        fileInfo = await beforeDeadline(vscode.workspace.fs.stat(childUri), deadline);
      } catch {
        truncated = true;
        continue;
      }

      if ((fileInfo.type & vscode.FileType.SymbolicLink) !== 0 || (fileInfo.type & vscode.FileType.File) === 0) {
        continue;
      }

      if (fileInfo.size > MAX_FILE_BYTES) {
        truncated = true;
        continue;
      }

      let bytes: Uint8Array;

      try {
        bytes = await beforeDeadline(vscode.workspace.fs.readFile(childUri), deadline);
      } catch {
        truncated = true;
        continue;
      }

      if (bytes.byteLength > MAX_FILE_BYTES) {
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

        let patternMatch: RegExpExecArray | null = null;
        let textMatchOffset = -1;
        if (options.pattern) {
          options.pattern.lastIndex = 0;
          patternMatch = options.pattern.exec(line);
        } else {
          textMatchOffset = line.toLowerCase().indexOf(cleanQuery.toLowerCase());
        }
        const lineMatches = options.pattern ? patternMatch !== null : textMatchOffset >= 0;

        if (!lineMatches) {
          continue;
        }

        const identifierOffset = identifierMatchOffset(
          line,
          cleanQuery,
          identifierPattern
        );
        const isIdentifier = identifierOffset !== undefined;
        const bucket = isIdentifier ? identifierMatches : textMatches;

        if (bucket.length >= MAX_CANDIDATES_PER_SIGNAL) {
          truncated = true;
          continue;
        }

        const matchOffset = identifierOffset ?? (patternMatch
          ? patternMatch.index + (patternMatch[1]?.length ?? 0)
          : textMatchOffset);
        const excerpt = makeExcerpt(line, cleanQuery, Math.max(0, matchOffset));
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

  // Keeps identifier matches ahead of plain text, then prefers a matching path hint.
  candidates.sort((left, right) => {
    if (left.signal !== right.signal) {
      return left.signal === "identifier_match" ? -1 : 1;
    }

    if (pathHint) {
      const leftMatchesHint = left.path.toLowerCase().includes(pathHint);
      const rightMatchesHint = right.path.toLowerCase().includes(pathHint);

      if (leftMatchesHint !== rightMatchesHint) {
        return leftMatchesHint ? -1 : 1;
      }
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
