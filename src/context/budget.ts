import type { ContextRow } from "../shared/types";

export interface ContextCharge {
  tool: ContextRow["tool"];
  query: string;
  path: string;
  startLine: number;
  endLine: number;
  signal: ContextRow["signal"];
  content: string;
  truncated?: boolean;
}

// Reserves context synchronously, so parallel tool calls cannot double-spend.
export class RunContextBudget {
  private usedTokens = 0;
  private readonly seen = new Set<string>();
  private readonly rows: ContextRow[] = [];
  private readonly encoder = new TextEncoder();
  readonly limitTokens: number;

  constructor(readonly runId: string, limitTokens = 6000) {
    if (!runId || !Number.isFinite(limitTokens) || limitTokens < 0) {
      throw new Error("A run ID and a non-negative context budget are required.");
    }

    this.limitTokens = Math.floor(limitTokens);
  }

  get cumulativeTokens(): number {
    return this.usedTokens;
  }

  get remainingTokens(): number {
    return Math.max(0, this.limitTokens - this.usedTokens);
  }

  get contextRows(): ContextRow[] {
    return [...this.rows];
  }

  reserve(charge: ContextCharge): ContextRow {
    const estimatedTokens = Math.ceil(this.encoder.encode(charge.content).byteLength / 4);
    const contentKey = [charge.path, charge.startLine, charge.endLine, charge.content].join("\0");
    const duplicate = this.seen.has(contentKey);
    const allowed = !duplicate && estimatedTokens <= this.remainingTokens;

    if (allowed) {
      this.seen.add(contentKey);
      this.usedTokens += estimatedTokens;
    }

    const row: ContextRow = {
      runId: this.runId,
      tool: charge.tool,
      query: charge.query,
      path: charge.path,
      startLine: charge.startLine,
      endLine: charge.endLine,
      signal: charge.signal,
      sentToModel: allowed,
      costTokens: allowed ? estimatedTokens : 0,
      cumulativeTokens: this.usedTokens,
      ...(duplicate
        ? { exclusion: "duplicate" as const }
        : !allowed
          ? { exclusion: "over_budget" as const }
          : charge.truncated
            ? { exclusion: "truncated" as const }
            : {})
    };

    this.rows.push(row);
    return row;
  }
}
