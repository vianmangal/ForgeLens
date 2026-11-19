import type { Failure, Harness, HarnessHooks, Selection } from "./harness";
import type { RunState } from "../shared/types";

export interface FallbackOptions {
  backupModel(): string;
  notice(message: string): void;
  problem(message: string): void;
}

interface Plan {
  instruction: string;
  selection?: Selection;
  preparedState?: unknown;
  primary?: Failure;
  next?: Promise<RunState>;
  followBackup?: (backup: Promise<RunState>) => void;
}

export class Fallback {
  private harness?: Pick<Harness, "startRun" | "onRunFailed">;
  private hooks: HarnessHooks = {};
  private plans = new Map<string, Plan>();
  private pending?: Plan;
  private retired = new Set<string>();
  private invalidated = new Set<string>();

  constructor(private options: FallbackOptions) {}

  guard(hooks: HarnessHooks): HarnessHooks {
    this.hooks = hooks;
    return {
      onState: state => {
        this.bind(state.runId);
        if (!this.retired.has(state.runId)) hooks.onState?.(state);
      },
      prepareInput: async (runId, content, signal) => {
        const plan = this.plans.get(runId);
        // Carries resolved mention choices forward; each run charges them to its own ledger.
        const prepared = await hooks.prepareInput?.(runId, content, signal, plan?.preparedState) ?? content;
        if (typeof prepared !== "string" && plan) plan.preparedState = prepared.state;
        return prepared;
      },
      prepareSelection: (runId, selection) => hooks.prepareSelection ? hooks.prepareSelection(runId, selection) : selection,
      onDelta: (runId, text) => { if (!this.retired.has(runId)) hooks.onDelta?.(runId, text); },
      onApproval: (runId, hunkId, toolCallId) => { if (!this.retired.has(runId)) hooks.onApproval?.(runId, hunkId, toolCallId); },
      onDecision: (runId, hunkId, allowed) => { if (!this.retired.has(runId)) hooks.onDecision?.(runId, hunkId, allowed); },
      onInvalidate: runId => this.invalidate(runId)
    };
  }

  attach(harness: Pick<Harness, "startRun" | "onRunFailed">): () => void {
    this.harness = harness;
    return harness.onRunFailed(failure => this.failed(failure));
  }

  start(model: string, instruction: string, selection?: Selection): Promise<RunState> {
    const plan: Plan = { instruction, selection };
    const primary = this.run(model, plan);
    return new Promise((resolve, reject) => {
      plan.followBackup = resolve;
      (plan.next ?? primary).then(resolve, reject);
    });
  }

  private run(model: string, plan: Plan): Promise<RunState> {
    if (!this.harness) throw new Error("Attach a harness before starting a run.");
    this.pending = plan;
    try {
      return this.harness.startRun(model, plan.instruction, plan.selection, plan.primary?.runId);
    } finally {
      this.pending = undefined;
    }
  }

  private bind(runId: string) {
    if (!this.pending || this.plans.has(runId)) return;
    this.plans.set(runId, this.pending);
    this.pending = undefined;
  }

  private invalidate(runId: string) {
    if (this.invalidated.has(runId)) return;
    this.invalidated.add(runId);
    this.hooks.onInvalidate?.(runId);
  }

  private failed(failure: Failure) {
    if (failure.kind === "cancelled") return;
    if (failure.kind === "input") {
      this.options.problem(failure.message);
      return;
    }
    const plan = this.plans.get(failure.runId);
    if (!plan || plan.next) {
      this.options.problem(failure.message);
      return;
    }
    if (plan.primary) {
      this.options.problem("Primary model " + plan.primary.model + " failed (" + plan.primary.message +
        ") and backup model " + failure.model + " also failed (" + failure.message + "). The run has stopped.");
      return;
    }
    const backup = this.options.backupModel().trim();
    if (failure.kind === "tool" || !backup || backup === failure.model) {
      this.options.problem(failure.message);
      return;
    }
    if (failure.checkMayHaveRun) {
      this.options.problem(failure.message + " Automatic fallback stopped because run_check may already have run. Check its result before retrying.");
      return;
    }
    this.retired.add(failure.runId);
    this.invalidate(failure.runId);
    try {
      plan.next = this.run(backup, {
        instruction: plan.instruction,
        selection: plan.selection,
        preparedState: plan.preparedState,
        primary: failure
      });
    } catch (error) {
      this.options.problem("Primary model failed (" + failure.message + ") and backup model " + backup +
        " could not start: " + (error instanceof Error ? error.message : String(error)));
      return;
    }
    plan.followBackup?.(plan.next);
    this.options.notice("Primary model failed → using backup " + backup);
  }
}
