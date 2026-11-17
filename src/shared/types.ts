export type RunId = string;
export type HunkId = string;

export interface SourceSnapshot {
  snapshotId: string;
  path: string;
  documentVersion: number;
  contentHash: string;
}

export interface Hunk {
  id: HunkId;
  runId: RunId;
  path: string;
  snapshotId: string;
  startLine: number;
  endLine: number;
  oldText: string;
  newText: string;
  status: "proposed" | "approval_requested" | "accepted" | "rejected" | "applied" | "invalidated";
  toolCallId?: string;
}

export interface ContextRow {
  runId: RunId;
  tool: "search_text" | "find_symbol" | "read_range" | "mention";
  query: string;
  path: string;
  startLine: number;
  endLine: number;
  signal: "explicit_mention" | "symbol_definition" | "identifier_match" | "text_match" | "path_match";
  sentToModel: boolean;
  costTokens: number;
  cumulativeTokens: number;
  exclusion?: "truncated" | "duplicate" | "over_budget";
}

export interface RunState {
  runId: RunId;
  sessionId: string;
  turnId?: string;
  lastEventId?: string;
  model: string;
  status: "streaming" | "awaiting_approval" | "ready_to_apply" | "applied" | "cancelled" | "failed" | "fell_back";
}
