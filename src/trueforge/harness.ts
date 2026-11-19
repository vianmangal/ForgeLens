import { randomUUID } from "node:crypto";
import type { TrueForge, TrueForgeApi as Api, mergeEventDelta } from "@truefoundry/trueforge-sdk" with { "resolution-mode": "import" };
import type { RunState } from "../shared/types";

export interface Selection {
  path: string;
  startLine: number;
  endLine: number;
  text?: string;
  documentVersion?: number;
  truncated?: boolean;
}

export interface Failure {
  runId: string;
  model: string;
  kind: "auth" | "network" | "server" | "cancelled" | "tool" | "input";
  message: string;
  checkMayHaveRun?: boolean;
}

export interface HarnessHooks {
  onState?(state: RunState): void;
  prepareInput?(runId: string, content: string, signal: AbortSignal, previousState?: unknown): Promise<string | PreparedInput>;
  prepareSelection?(runId: string, selection: Selection): Selection;
  onDelta?(runId: string, text: string): void;
  onApproval?(runId: string, hunkId: string, toolCallId: string): void;
  onDecision?(runId: string, hunkId: string, allowed: boolean): void;
  onInvalidate?(runId: string): void;
}

export interface PreparedInput {
  content: string;
  state?: unknown;
}

type Events = AsyncIterable<Api.TurnStreamingEvent>;
type Sessions = Pick<TrueForge["sessions"], "create" | "get" | "createTurnStream" | "createTurnEvents" |
  "subscribeToTurn" | "getTurn" | "listTurnEvents" | "cancel">;

const request = { timeoutInSeconds: 600, maxRetries: 0 };
type Call = { threadId: string; hunkId?: string; decision?: Api.ApprovalDecision };

class Run {
  state: RunState;
  active = true;
  controller = new AbortController();
  proposed = new Set<string>();
  requested = new Set<string>();
  pending = new Map<string, Call>();
  wake?: () => void;
  opening?: Promise<unknown>;
  sessionOpening = false;
  finished?: Promise<RunState>;
  cancellation?: Promise<void>;
  drainError?: Error;
  checkMayHaveRun = false;
  mcpSessionId?: string;
  terminalTurn = false;
  openedTurn = false;
  lastMessage = new Map<string, Api.ModelMessageEvent>();
  emitted = new Map<string, string>();
  seen = new Set<string>();

  constructor(model: string) {
    this.state = { runId: randomUUID(), model, sessionId: "", status: "streaming" };
  }

  get options() {
    return { ...request, abortSignal: this.controller.signal };
  }
}

function isRunCheck(call: Api.ToolCall, connector: string): boolean {
  const info = call.toolInfo;
  if (info.type === "mcp") return info.serverName === connector && info.name === "run_check";
  if (info.name !== "call_tool") return false;
  // Deferred calls expose the system wrapper in both live and replayed events.
  try {
    const target = JSON.parse(call.function.arguments);
    return target?.mcp_server === connector && target.tool_name === "run_check";
  } catch {
    return false;
  }
}

function approvedHunkId(call: Api.ToolCall, connector: string): unknown {
  try {
    const args = JSON.parse(call.function.arguments);
    if (call.toolInfo.type === "mcp") {
      return call.toolInfo.serverName === connector && call.toolInfo.name === "approve_hunk" ? args?.hunkId : undefined;
    }
    if (call.toolInfo.name !== "call_tool" || args?.mcp_server !== connector || args.tool_name !== "approve_hunk") return undefined;
    const input = typeof args.input === "string" ? JSON.parse(args.input) : args.input;
    return input?.hunkId;
  } catch {
    return undefined;
  }
}

function failureKind(error: unknown, message: string): Failure["kind"] {
  const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
  const description = String(status ?? "") + " " + message;
  if (/\b(401|403|unauthorized|forbidden|authentication)\b|invalid.{0,12}(api.?key|credential)|\bapi.?key\s+(?:is\s+)?not\s+valid\b/i.test(description)) return "auth";
  if (/\b(429|5\d\d)\b|rate limit|internal server error|service unavailable|bad gateway/i.test(description)) return "server";
  if (/network|fetch failed|failed to fetch|connection|socket|timed?\s*out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|stream ended/i.test(description)) return "network";
  return "tool";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Harness {
  private current?: Run;
  private mergeDelta?: typeof mergeEventDelta;
  private failures = new Set<(failure: Failure) => void>();

  constructor(private sessions: Sessions, private spec: Api.AgentSpec, private hooks: HarnessHooks = {},
    private connector = "forgelens") {}

  get state(): RunState | undefined {
    return this.current && { ...this.current.state };
  }

  isActive(runId: string): boolean {
    return this.current?.state.runId === runId && this.current.active;
  }

  runForMcpSession(sessionId: string): string | undefined {
    const run = this.current;
    return run?.active && run.mcpSessionId === sessionId ? run.state.runId : undefined;
  }

  onRunFailed(callback: (failure: Failure) => void): () => void {
    this.failures.add(callback);
    return () => { this.failures.delete(callback); };
  }

  registerProposed(runId: string, hunkId: string): boolean {
    if (!hunkId || !this.isActive(runId)) return false;
    this.current!.proposed.add(hunkId);
    return true;
  }

  startRun(modelName: string, instruction: string, selection?: Selection, replacesRunId?: string): Promise<RunState> {
    if (this.current?.active) throw new Error("Finish or cancel the current run first.");
    if (!modelName.trim() || !instruction.trim()) throw new Error("Provide a configured model name and an instruction.");
    if (selection && (!selection.path || !Number.isSafeInteger(selection.startLine) ||
      !Number.isSafeInteger(selection.endLine) || selection.startLine < 1 || selection.endLine < selection.startLine)) {
      throw new Error("Provide a selection with a path and a valid 1-based line range.");
    }
    if (this.current?.state.status === "ready_to_apply") this.hooks.onInvalidate?.(this.current.state.runId);
    const run = new Run(modelName);
    if (replacesRunId) run.state.replacesRunId = replacesRunId;
    this.current = run;
    this.publish(run);
    run.finished = this.prepareAndExecute(run, instruction, selection);
    return run.finished;
  }

  // Resolves and budgets explicit context before opening a TrueForge session.
  private async prepareAndExecute(run: Run, instruction: string, selection?: Selection): Promise<RunState> {
    let prepared: string | PreparedInput;
    let sentSelection = selection;
    try {
      prepared = this.hooks.prepareInput
        ? await this.hooks.prepareInput(run.state.runId, instruction, run.controller.signal)
        : instruction;
      if (run.active && selection && this.hooks.prepareSelection) {
        sentSelection = this.hooks.prepareSelection(run.state.runId, selection);
      }
    } catch (error) {
      if (run.active) {
        const message = messageOf(error);
        this.stop(run, "input", message);
      }
      return { ...run.state };
    }
    if (!run.active) return { ...run.state };
    let content = typeof prepared === "string" ? prepared : prepared.content;
    if (sentSelection) content += "\n\nEditor selection (1-based lines):\n" + JSON.stringify(sentSelection);
    return this.execute(run, content);
  }

  approve(hunkId: string): boolean {
    return this.decide(hunkId, { status: "allow" });
  }

  reject(hunkId: string, reason = "Rejected by the developer. This decision is final; do not propose the same change again."): boolean {
    return this.decide(hunkId, { status: "deny", reason });
  }

  private decide(hunkId: string, decision: Api.ApprovalDecision): boolean {
    const run = this.current;
    if (!run?.active) return false;
    const call = Array.from(run.pending.values()).find(item => item.hunkId === hunkId);
    if (!call || call.decision) return false;
    call.decision = decision;
    run.wake?.();
    return true;
  }

  cancel(): Promise<void> {
    const run = this.current;
    if (!run) return Promise.resolve();
    if (run.cancellation) return run.cancellation;
    if (!run.active && run.state.status !== "ready_to_apply") return Promise.resolve();
    this.stop(run, "cancelled", "Cancelled by the developer.");
    if (!run.state.sessionId && !run.sessionOpening) run.controller.abort();
    run.cancellation = this.cancelAndDrain(run);
    return run.cancellation;
  }

  private async cancelAndDrain(run: Run): Promise<void> {
    try {
      if (!run.state.sessionId && !run.sessionOpening) run.controller.abort();
      await run.opening?.catch(() => {});
      if (run.state.sessionId && !run.terminalTurn) {
        await this.sessions.cancel(run.state.sessionId, {}, request);
      }
    } catch (error) {
      run.controller.abort();
      throw error;
    } finally {
      run.wake?.();
    }
    await run.finished;
    if (run.drainError) throw run.drainError;
  }

  private publish(run: Run) {
    if (this.current === run) this.hooks.onState?.({ ...run.state });
  }

  private stop(run: Run, kind: Failure["kind"], message: string) {
    run.active = false;
    run.state.status = kind === "cancelled" ? "cancelled" : "failed";
    this.hooks.onInvalidate?.(run.state.runId);
    this.publish(run);
    const failure: Failure = { runId: run.state.runId, model: run.state.model, kind, message };
    if (run.checkMayHaveRun) failure.checkMayHaveRun = true;
    for (const listener of this.failures) listener(failure);
  }

  private async execute(run: Run, content: string): Promise<RunState> {
    try {
      run.sessionOpening = true;
      const opening = this.sessions.create({
        agent: { spec: { ...this.spec, model: { ...this.spec.model, name: run.state.model } } }
      }, run.options);
      run.opening = opening;
      run.state.sessionId = (await opening).data.id;
      run.sessionOpening = false;
      let sentReminder = false;
      while (run.active) {
        const previousTurnId = run.state.turnId;
        run.terminalTurn = false;
        run.openedTurn = false;
        run.state.turnId = undefined;
        run.state.lastEventId = undefined;
        run.lastMessage.clear();
        run.emitted.clear();
        run.seen.clear();
        const stream = this.sessions.createTurnStream(run.state.sessionId, {
          input: [{ type: "user.message", content }]
        }, run.options);
        run.opening = stream;
        const initial = await stream;
        run.openedTurn = true;
        await this.turn(run, initial, previousTurnId);
        if (!run.active) break;
        if (run.pending.size) throw new Error("The turn ended before its hunk approval decisions were recorded.");
        const missing = [...run.proposed].filter(id => !run.requested.has(id));
        if (!missing.length) {
          run.active = false;
          run.state.status = "ready_to_apply";
          this.publish(run);
          break;
        }
        if (sentReminder) throw new Error("Missing hunk approval requests after follow-up: " + missing.join(", "));
        sentReminder = true;
        content = "Call approve_hunk once for each of these previously proposed hunk IDs: " +
          JSON.stringify(missing) + ". Do not propose additional edits.";
      }
    } catch (error) {
      if (run.active) {
        const message = messageOf(error);
        this.stop(run, failureKind(error, message), message);
        if (run.state.sessionId && !run.terminalTurn) {
          await this.sessions.cancel(run.state.sessionId, {}, request).catch(() => {});
        }
      } else if (!run.terminalTurn && run.openedTurn) {
        run.drainError = new Error("Unable to confirm the end of the cancelled turn: " + messageOf(error));
      }
    } finally {
      run.sessionOpening = false;
      run.controller.abort();
      run.wake = undefined;
    }
    return { ...run.state };
  }

  private async turn(run: Run, initial: Events, previousTurnId?: string): Promise<void> {
    this.mergeDelta ??= (await import("@truefoundry/trueforge-sdk")).mergeEventDelta;
    let stream = initial;
    let recoveryCount = 0;
    while (true) {
      let boundary: "done" | "paused" | undefined;
      let dropped: unknown = new Error("TrueForge stream ended before turn.done.");
      try {
        for await (const event of stream) {
          boundary = this.event(run, event);
          if (boundary) break;
        }
      } catch (error) {
        dropped = error;
      }
      if (boundary === "done") return;
      if (boundary === "paused") {
        try {
          stream = await this.resumePause(run);
        } catch (error) {
          if (run.active || run.controller.signal.aborted) throw error;
          stream = await this.recover(run);
        }
        recoveryCount = 0;
        continue;
      }
      if (++recoveryCount > 3 || run.controller.signal.aborted) throw dropped;
      if (!run.state.turnId) {
        const { data } = await this.sessions.get(run.state.sessionId, run.options);
        const latest = data.lastTurnDetails?.id;
        if (!latest || latest === previousTurnId) throw dropped;
        run.state.turnId = latest;
      }
      stream = await this.recover(run);
    }
  }

  private async recover(run: Run): Promise<Events> {
    const { sessionId, turnId, lastEventId } = run.state;
    const { data } = await this.sessions.getTurn(sessionId, turnId!, run.options);
    if (data.state.status === "running" || data.state.status === "paused") {
      return await this.sessions.subscribeToTurn(sessionId, turnId!, { fromEventId: lastEventId }, run.options);
    }
    return await this.sessions.listTurnEvents(sessionId, turnId!, { order: "asc" }, run.options);
  }

  private event(run: Run, event: Api.TurnStreamingEvent): "done" | "paused" | undefined {
    run.state.lastEventId = event.id;
    if (event.type === "turn.created") {
      run.state.turnId = event.turnId;
      if (run.active && !run.seen.has(event.id)) this.publish(run);
    }
    if (event.type === "turn.done") {
      run.terminalTurn = true;
      if (run.active && event.state.status === "error") {
        this.stop(run, failureKind(undefined, event.state.message), event.state.message);
      } else if (run.active && event.state.status === "cancelled") {
        this.stop(run, "cancelled", "TrueForge cancelled the turn: " + event.state.reason);
      }
      return "done";
    }
    if (!run.active) return;
    if (event.type === "mcp.initialize") {
      const server = event.mcpServers.find(server => server.name === this.connector);
      if (server) run.mcpSessionId = server.sessionId;
      return;
    }
    if (event.type === "model.message" || event.type === "model.message.delta") {
      this.modelMessage(run, event);
      return;
    }
    if (run.seen.has(event.id)) return;
    run.seen.add(event.id);
    if (event.type === "tool.response" && !run.checkMayHaveRun) {
      // A decision can also be made in the TrueForge session UI.
      for (const message of run.lastMessage.values()) {
        if (message.threadId === event.threadId &&
          message.toolCalls?.some(call => call.id === event.toolCallId && isRunCheck(call, this.connector))) {
          run.checkMayHaveRun = true;
          break;
        }
      }
    }
    if (event.type === "tool.approval_required") {
      for (const ref of event.toolCalls) this.mapApproval(run, event.threadId, ref);
    }
    if (event.type === "turn.update" && event.state.status === "paused") return "paused";
  }

  private modelMessage(run: Run, event: Api.ModelMessageEvent | Api.ModelMessageDeltaEvent) {
    if (event.type === "model.message") run.lastMessage.set(event.id, structuredClone(event));
    const message = run.lastMessage.get(event.id);
    if (!message) return;
    if (event.type === "model.message.delta") this.mergeDelta!(message, event);
    if (message.threadId !== "main") return;
    const content = typeof message.content === "string" ? message.content :
      message.content?.map(part => part.type === "text" ? part.text : "").join("") ?? "";
    const shown = run.emitted.get(event.id) ?? "";
    if (content.length > shown.length && content.startsWith(shown)) {
      run.emitted.set(event.id, content);
      this.hooks.onDelta?.(run.state.runId, content.slice(shown.length));
    }
  }

  private mapApproval(run: Run, threadId: string, ref: Api.ToolCallRef) {
    if (run.pending.has(ref.id)) return;
    const msg = run.lastMessage.get(ref.sourceEventId);
    const call = msg?.threadId === threadId && msg.toolCalls?.find(item => item.id === ref.id);
    let hunkId: unknown;
    if (call && isRunCheck(call, this.connector)) {
      // The session UI can approve this check before we subscribe to its result.
      run.checkMayHaveRun = true;
      run.pending.set(ref.id, { threadId, decision: { status: "allow" } });
      return;
    }
    if (call) hunkId = approvedHunkId(call, this.connector);
    if (typeof hunkId !== "string" || !run.proposed.has(hunkId) || run.requested.has(hunkId)) {
      run.pending.set(ref.id, { threadId, decision: { status: "deny", reason: "No matching pending ForgeLens hunk in this run." } });
      return;
    }
    run.requested.add(hunkId);
    run.pending.set(ref.id, { threadId, hunkId });
    this.hooks.onApproval?.(run.state.runId, hunkId, ref.id);
  }

  private async resumePause(run: Run): Promise<Events> {
    if (!run.pending.size) throw new Error("TrueForge paused without a ForgeLens hunk approval. Open the session to inspect the requested action.");
    run.state.status = "awaiting_approval";
    this.publish(run);
    while (run.active && [...run.pending.values()].some(call => !call.decision)) {
      await new Promise<void>(resolve => { run.wake = resolve; });
      run.wake = undefined;
    }
    if (!run.active) return this.recover(run);
    const { sessionId, turnId, lastEventId } = run.state;
    const stream = await this.sessions.subscribeToTurn(sessionId, turnId!, { afterEventId: lastEventId }, run.options);
    if (!run.active) return stream;
    const events: Api.TurnUserEventMessage[] = [...run.pending].map(([toolCallId, call]) => ({
      type: "user.tool_approval", threadId: call.threadId, toolCallId, approval: call.decision!
    }));
    await this.sessions.createTurnEvents(sessionId, turnId!, { events }, run.options);
    if (run.active) {
      for (const call of run.pending.values()) {
        if (call.hunkId) this.hooks.onDecision?.(run.state.runId, call.hunkId, call.decision!.status === "allow");
      }
      run.pending.clear();
      run.state.status = "streaming";
      this.publish(run);
    }
    return stream;
  }
}
