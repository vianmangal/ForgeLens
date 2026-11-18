import * as vscode from "vscode";
import * as z from "zod/v4";
import { RunContextBudget } from "../context/budget";
import { searchText } from "../context/search";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type CurrentRunId = () => string | undefined;

const budgetsByRun = new Map<string, RunContextBudget>();

// Reuses one budget for each run, so retrieval tools share the same limit.
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

export function clearBudgetForRun(runId: string): void {
  budgetsByRun.delete(runId);
}

// Registers search_text and gets the run ID from ForgeLens, never from tool input.
export function registerSearchTextTool(
  server: McpServer,
  currentRunId: CurrentRunId
): void {
  server.registerTool(
    "search_text",
    {
      description: "Search workspace text and return ranked, budgeted excerpts.",
      inputSchema: {
        query: z.string().min(1).max(256),
        scope: z.string().optional(),
        limit: z.number().int().min(1).max(30).optional()
      }
    },
    async ({ query, scope, limit }) => {
      const runId = currentRunId();

      if (!runId) {
        return {
          content: [{ type: "text", text: "There is no active ForgeLens run." }],
          isError: true
        };
      }

      try {
        const result = await searchText(
          query,
          getBudgetForRun(runId),
          scope,
          limit ?? 10
        );

        return {
          content: [{ type: "text", text: JSON.stringify(result) }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: error instanceof Error ? error.message : "Search failed."
          }],
          isError: true
        };
      }
    }
  );
}