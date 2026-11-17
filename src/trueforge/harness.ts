import { randomUUID } from "node:crypto";
import type { TrueForge, TrueForgeApi as Api, mergeEventDelta } from "@truefoundry/trueforge-sdk" with { "resolution-mode": "import" };
import type { RunState } from "../shared/types";

export interface Selection {
  path: string;
  startLine: number;
  endLine: number;
  text?: string;
  documentVersion?: number;
}

export interface Failure {
  runId: string;
  model: string;
  kind: "auth" | "network" | "server" | "cancelled" | "tool";
  message: string;
}

export interface HarnessHooks {
  onState?(state: RunState): void;
  onDelta?(runId: string, text: string): void;
  onApproval?(runId: string, hunkId: string, toolCallId: string): void;
  onDecision?(runId: string, hunkId: string, allowed: boolean): void;
  onInvalidate?(runId: string): void;
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
  finished?: Promise<RunState>;
  cancellation?: Promise<void>;
  drainError?: Error;
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

function failureKind(error: unknown, message: string): Failure["kind"] {
  const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
  const description = String(status ?? "") + " " + message;
  if (/\b(401|403|unauthorized|forbidden|authentication)\b|invalid.{0,12}(api.?key|credential)/i.test(description)) return "auth";
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

  onRunFailed(callback: (failure: Failure) => void): () => void {
    this.failures.add(callback);
    return () => { this.failures.delete(callback); };
  }

  registerProposed(runId: string, hunkId: string): boolean {
    if (!hunkId || !this.isActive(runId)) return false;
    this.current!.proposed.add(hunkId);
    return true;
  }

  startRun(modelName: string, instruction: string, selection?: Selection): Promise<RunState> {
    if (this.current?.active) throw new Error("Finish or cancel the current run first.");
    if (!modelName.trim() || !instruction.trim()) throw new Error("Provide a configured model name and an instruction.");
    if (selection && (!selection.path || !Number.isSafeInteger(selection.startLine) ||
      !Number.isSafeInteger(selection.endLine) || selection.startLine < 1 || selection.endLine < selection.startLine)) {
      throw new Error("Provide a selection with a path and a valid 1-based line range.");
    }
    if (this.current?.state.status === "ready_to_apply") this.hooks.onInvalidate?.(this.current.state.runId);
    const run = new Run(modelName);
    this.current = run;
    const content = selection ? instruction + "\n\nEditor selection (1-based lines):\n" + JSON.stringify(selection) : instruction;
    run.finished = this.execute(run, content);
    this.publish(run);
    return run.finished;
  }

  approve(hunkId: string): boolean {
    return this.decide(hunkId, { status: "allow" });
  }

  reject(hunkId: string, reason = "Rejected by the developer."): boolean {
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
    run.cancellation = this.cancelAndDrain(run);
    return run.cancellation;
  }

  private async cancelAndDrain(run: Run): Promise<void> {
    try {
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
    for (const listener of this.failures) listener({ runId: run.state.runId, model: run.state.model, kind, message });
  }

  private async execute(run: Run, content: string): Promise<RunState> {
    try {
      const opening = this.sessions.create({
        agent: { spec: { ...this.spec, model: { ...this.spec.model, name: run.state.model } } }
      }, run.options);
      run.opening = opening;
      run.state.sessionId = (await opening).data.id;
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
    if (event.type === "model.message" || event.type === "model.message.delta") {
      this.modelMessage(run, event);
      return;
    }
    if (run.seen.has(event.id)) return;
    run.seen.add(event.id);
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
    if (call && call.toolInfo.type === "mcp" && call.toolInfo.serverName === this.connector &&
      call.toolInfo.name === "approve_hunk") {
      try { hunkId = JSON.parse(call.function.arguments)?.hunkId; } catch {}
    }
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
