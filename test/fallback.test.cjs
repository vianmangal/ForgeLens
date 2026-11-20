const test = require("node:test");
const assert = require("node:assert/strict");
const { Harness } = require("../dist/trueforge/harness.js");
const { Fallback } = require("../dist/trueforge/fallback.js");

const created = (turnId = "t1") => ({ id: "created-" + turnId, type: "turn.created", turnId });
const done = (status = "done", fields = {}) => ({ id: "done", type: "turn.done", state: { status, ...fields } });
const base = { type: "model.message", id: "msg", content: "", threadId: "main" };
const delta = content => ({ type: "model.message.delta", id: "msg", threadId: "main", content });
const selection = { path: "a.ts", startLine: 3, endLine: 4, text: "line" };
const switched = "Primary model failed → using backup backup/model";

async function* events(...items) { yield* items; }

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function fixture(streams, backupModel = "backup/model") {
  const observed = { states: [], text: [], invalidate: [], approvals: [], notices: [], problems: [], failures: [], models: [], turns: [] };
  const sessions = {
    create: async body => {
      const model = body.agent.spec.model.name;
      observed.models.push(model);
      return { data: { id: model } };
    },
    createTurnStream: async (sid, body) => {
      observed.turns.push([sid, body.input[0].content]);
      return streams[sid]();
    },
    cancel: async () => {},
    ...streams.overrides
  };
  const fallback = new Fallback({
    backupModel: () => backupModel,
    notice: message => observed.notices.push(message),
    problem: message => observed.problems.push(message)
  });
  const hooks = fallback.guard({
    onState: state => observed.states.push(state),
    onDelta: (id, text) => observed.text.push([id, text]),
    onInvalidate: id => observed.invalidate.push(id),
    onApproval: (...args) => observed.approvals.push(args)
  });
  const harness = new Harness(sessions, { model: { name: "default/model" }, instructions: "Use the connector." }, hooks);
  fallback.attach(harness);
  harness.onRunFailed(failure => observed.failures.push(failure));
  return { harness, fallback, hooks, observed };
}

const backupWorks = () => events(created(), base, delta("fixed"), done());

test("an auth failure switches to the backup once with the same instruction and selection", async () => {
  const { fallback, observed } = fixture({
    "primary/model": () => events(created(), done("error", { message: "API key not valid. Please pass a valid API key." })),
    "backup/model": backupWorks
  });
  const state = await fallback.start("primary/model", "Edit", selection);
  const primaryId = observed.failures[0].runId;
  assert.equal(observed.failures[0].kind, "auth");
  assert.equal(state.model, "backup/model");
  assert.equal(state.status, "ready_to_apply");
  assert.notEqual(state.runId, primaryId);
  assert.deepEqual(observed.models, ["primary/model", "backup/model"]);
  assert.equal(observed.turns[0][1], observed.turns[1][1]);
  assert.match(observed.turns[1][1], /"startLine":3/);
  assert.deepEqual(observed.invalidate, [primaryId]);
  assert.deepEqual(observed.notices, [switched]);
  assert.deepEqual(observed.problems, []);
  assert.deepEqual(observed.text, [[state.runId, "fixed"]]);
});

for (const [message, kind] of [["fetch failed", "network"], ["HTTP 503 service unavailable", "server"]]) {
  test("a " + kind + " failure after TrueForge's retries switches to the backup", async () => {
    const { fallback, observed } = fixture({
      "primary/model": async () => { throw new Error(message); },
      "backup/model": backupWorks
    });
    const state = await fallback.start("primary/model", "Edit", selection);
    assert.equal(observed.failures[0].kind, kind);
    assert.equal(state.model, "backup/model");
    assert.equal(state.status, "ready_to_apply");
    assert.deepEqual(observed.models, ["primary/model", "backup/model"]);
    assert.deepEqual(observed.invalidate, [observed.failures[0].runId]);
    assert.deepEqual(observed.notices, [switched]);
    assert.deepEqual(observed.problems, []);
  });
}

test("when the backup also fails the run stops with one clear error and no second switch", async () => {
  const { fallback, observed } = fixture({
    "primary/model": () => events(created(), done("error", { message: "401 unauthorized" })),
    "backup/model": () => events(created(), done("error", { message: "connection refused" }))
  });
  const state = await fallback.start("primary/model", "Edit");
  assert.equal(state.model, "backup/model");
  assert.equal(state.status, "failed");
  assert.deepEqual(observed.models, ["primary/model", "backup/model"]);
  assert.deepEqual(observed.notices, [switched]);
  assert.equal(observed.problems.length, 1);
  assert.match(observed.problems[0], /primary\/model failed \(401 unauthorized\)/);
  assert.match(observed.problems[0], /backup\/model also failed \(connection refused\)/);
});

test("cancelling the primary never switches to the backup", async () => {
  const streaming = deferred();
  const remote = deferred();
  const { harness, fallback, observed } = fixture({
    "primary/model": () => (async function* () {
      yield created(); yield base; yield delta("before");
      streaming.resolve();
      await remote.promise;
      yield done("cancelled", { reason: "user" });
    })(),
    "backup/model": () => assert.fail("the backup must not start after a cancel"),
    overrides: { cancel: async () => { remote.resolve(); } }
  });
  const finish = fallback.start("primary/model", "Edit");
  await streaming.promise;
  await harness.cancel();
  const state = await finish;
  assert.equal(state.status, "cancelled");
  assert.equal(state.model, "primary/model");
  assert.deepEqual(observed.models, ["primary/model"]);
  assert.deepEqual(observed.failures.map(f => f.kind), ["cancelled"]);
  assert.deepEqual(observed.notices, []);
  assert.deepEqual(observed.problems, []);
});

test("a tool failure keeps the existing error and does not switch", async () => {
  const { fallback, observed } = fixture({
    "primary/model": () => events(created(), done("error", { message: "malformed tool response" })),
    "backup/model": () => assert.fail("the backup must not start after a tool error")
  });
  const state = await fallback.start("primary/model", "Edit");
  assert.equal(state.status, "failed");
  assert.deepEqual(observed.models, ["primary/model"]);
  assert.deepEqual(observed.notices, []);
  assert.deepEqual(observed.problems, ["malformed tool response"]);
});

test("late events from the primary after the switch are ignored", async () => {
  const { harness, fallback, hooks, observed } = fixture({
    "primary/model": () => events(created(), base, delta("primary "), done("error", { message: "403 forbidden" })),
    "backup/model": () => events(created(), base, delta("backup"), done())
  });
  const state = await fallback.start("primary/model", "Edit");
  const primaryId = observed.failures[0].runId;
  const primaryStates = observed.states.filter(s => s.runId === primaryId).length;
  hooks.onDelta(primaryId, "late");
  hooks.onApproval(primaryId, "h1", "call");
  hooks.onState({ ...state, runId: primaryId, model: "primary/model", status: "streaming" });
  hooks.onInvalidate(primaryId);
  assert.equal(harness.registerProposed(primaryId, "h1"), false);
  assert.deepEqual(observed.text, [[primaryId, "primary "], [state.runId, "backup"]]);
  assert.deepEqual(observed.approvals, []);
  assert.equal(observed.states.filter(s => s.runId === primaryId).length, primaryStates);
  assert.deepEqual(observed.invalidate, [primaryId]);
  assert.equal(observed.states.at(-1).runId, state.runId);
});

test("the backup resolves the edit while primary cleanup is still pending", async () => {
  const cleanup = deferred();
  const backupDone = deferred();
  const { fallback, observed } = fixture({
    "primary/model": async () => { throw new Error("fetch failed"); },
    "backup/model": async function* () {
      try { yield* backupWorks(); } finally { backupDone.resolve(); }
    },
    overrides: { cancel: () => cleanup.promise }
  });
  try {
    const finish = fallback.start("primary/model", "Edit");
    await backupDone.promise;
    // Let the terminal state propagate while cleanup remains blocked.
    const result = await Promise.race([finish, new Promise(resolve => setImmediate(resolve))]);
    assert.equal(result?.status, "ready_to_apply");
    assert.equal(result?.runId, observed.states.at(-1).runId);
  } finally {
    cleanup.resolve();
  }
});

const checkCall = {
  id: "check", type: "function", function: { name: "run_check", arguments: "{}" },
  toolInfo: { type: "mcp", name: "run_check", serverId: "local", serverName: "forgelens" }
};

const deferredCheck = {
  ...checkCall,
  function: { name: "call_tool", arguments: JSON.stringify({ mcp_server: "forgelens", tool_name: "run_check", input: {} }) },
  toolInfo: { type: "truefoundry-system", name: "call_tool" }
};

for (const lostResponse of [false, true]) {
  test("a dispatched check prevents replay " + (lostResponse ? "when its approval response is lost" : "after it finishes"), async () => {
    const agent = require("../agent/forgelens.agent.json");
    assert.ok(agent.mcpServers[0].requireApprovalForTools.includes("run_check"));
    const sent = [];
    const { fallback, observed } = fixture({
      "primary/model": () => events(created(), { ...base, toolCalls: [lostResponse ? checkCall : deferredCheck] },
        { type: "tool.approval_required", id: "gate", threadId: "main", toolCalls: [{ id: "check", sourceEventId: "msg" }] },
        { type: "turn.update", id: "pause", state: { status: "paused" } }),
      "backup/model": backupWorks,
      overrides: {
        subscribeToTurn: async () => events({ type: "tool.response", id: "result", toolCallId: "check", threadId: "main", content: "ok" },
          done("error", { message: "HTTP 503" })),
        createTurnEvents: async (_session, _turn, { events }) => {
          sent.push(...events);
          if (lostResponse) throw new Error("connection reset");
        }
      }
    });
    const state = await fallback.start("primary/model", "Run the check");
    assert.deepEqual(sent.map(e => [e.toolCallId, e.approval.status]), [["check", "allow"]]);
    assert.equal(state.status, "failed");
    assert.deepEqual(observed.models, ["primary/model"]);
    assert.match(observed.problems[0], /run_check/);
  });
}

test("a completed check observed on the stream prevents replay without a local approval", async () => {
  const { fallback, observed } = fixture({
    "primary/model": () => events(created(), { ...base, toolCalls: [deferredCheck] },
      { type: "tool.response", id: "result", toolCallId: deferredCheck.id, threadId: "main", content: "ok" },
      done("error", { message: "HTTP 503" })),
    "backup/model": backupWorks
  });
  const state = await fallback.start("primary/model", "Run the check");
  assert.equal(state.status, "failed");
  assert.deepEqual(observed.models, ["primary/model"]);
});

test("a read-only tool can finish before a recoverable model failure", async () => {
  const read = { ...checkCall, toolInfo: { ...checkCall.toolInfo, name: "read_range" } };
  const { fallback, observed } = fixture({
    "primary/model": () => events(created(), { ...base, toolCalls: [read] },
      { type: "tool.response", id: "result", toolCallId: read.id, threadId: "main", content: "line" },
      done("error", { message: "HTTP 503" })),
    "backup/model": backupWorks
  });
  const state = await fallback.start("primary/model", "Read the selection", selection);
  const primary = observed.states[0].runId;
  assert.equal(state.status, "ready_to_apply");
  assert.equal(observed.states.find(s => s.runId !== primary).replacesRunId, primary);
});

test("a deferred check targeting another connector is denied and leaves fallback available", async () => {
  const foreign = {
    ...deferredCheck,
    function: { name: "call_tool", arguments: JSON.stringify({ mcp_server: "other", tool_name: "run_check", input: {} }) }
  };
  const sent = [];
  const { fallback } = fixture({
    "primary/model": () => events(created(), { ...base, toolCalls: [foreign] },
      { type: "tool.approval_required", id: "gate", threadId: "main", toolCalls: [{ id: "check", sourceEventId: "msg" }] },
      { type: "turn.update", id: "pause", state: { status: "paused" } }),
    "backup/model": backupWorks,
    overrides: {
      createTurnEvents: async (_session, _turn, { events }) => sent.push(...events),
      subscribeToTurn: async () => events(done("error", { message: "HTTP 503" }))
    }
  });
  const state = await fallback.start("primary/model", "Edit");
  assert.deepEqual(sent.map(e => e.approval.status), ["deny"]);
  assert.equal(state.model, "backup/model");
});

for (const serverName of ["forgelens", "other"]) {
  test("subscription loss with a pending check on " + serverName, async () => {
    const call = { ...checkCall, toolInfo: { ...checkCall.toolInfo, serverName } };
    const { fallback, observed } = fixture({
      "primary/model": () => events(created(), { ...base, toolCalls: [call] },
        { type: "tool.approval_required", id: "gate", threadId: "main", toolCalls: [{ id: call.id, sourceEventId: "msg" }] },
        { type: "turn.update", id: "pause", state: { status: "paused" } }),
      "backup/model": backupWorks,
      overrides: { subscribeToTurn: async () => { throw new Error("connection reset"); } }
    });
    const state = await fallback.start("primary/model", "Run the check");
    assert.equal(observed.failures[0].kind, "network");
    if (serverName === "forgelens") {
      assert.deepEqual(observed.models, ["primary/model"]);
      assert.equal(state.status, "failed");
      assert.match(observed.problems[0], /run_check/);
    } else {
      assert.equal(state.model, "backup/model");
      assert.equal(state.status, "ready_to_apply");
    }
  });
}

test("the backup run charges the selection to its own run and sends its prepared text", async () => {
  const charged = [];
  const turns = [];
  const fallback = new Fallback({ backupModel: () => "backup/model", notice() {}, problem() {} });
  const hooks = fallback.guard({
    prepareSelection: (runId, value) => { charged.push(runId); return { ...value, text: "prepared-" + charged.length }; }
  });
  const sessions = {
    create: async body => ({ data: { id: body.agent.spec.model.name } }),
    createTurnStream: async (sid, body) => {
      turns.push([sid, body.input[0].content]);
      return sid === "primary/model" ? events(created(), done("error", { message: "401 Unauthorized" })) : backupWorks();
    },
    cancel: async () => {}
  };
  const harness = new Harness(sessions, { model: { name: "default/model" }, instructions: "Use the connector." }, hooks);
  const runs = [];
  harness.onRunFailed(failure => runs.push(failure.runId));
  fallback.attach(harness);
  const state = await fallback.start("primary/model", "Edit", selection);
  assert.equal(state.model, "backup/model");
  assert.deepEqual(charged, [runs[0], state.runId]);
  assert.notEqual(runs[0], state.runId);
  assert.match(turns[0][1], /"text":"prepared-1"/);
  assert.match(turns[1][1], /"text":"prepared-2"/);
});

test("saved verification resumes the same session once and never replays applied work on the backup", async () => {
  let turn = 0;
  const { fallback, observed, harness } = fixture({
    "primary/model": () => ++turn === 1 ? events(created(), done()) :
      events(created("verify"), done("error", { message: "503 service unavailable" }))
  });
  const ready = await fallback.start("primary/model", "edit");
  assert.throws(() => harness.verifySaved("stale", ["a.py"], []), /no longer/);
  const pending = harness.verifySaved(ready.runId, ["a.py"], ["b.py:1-2"]);
  assert.equal(harness.isVerifying(ready.runId), true);
  assert.equal(harness.registerProposed(ready.runId, "late"), false);
  assert.throws(() => harness.verifySaved(ready.runId, ["a.py"], []), /no longer/);
  const finished = await pending;
  assert.equal(finished.status, "failed");
  assert.deepEqual(observed.models, ["primary/model"]);
  assert.equal(observed.turns.length, 2);
  assert.match(observed.turns[1][1], /"applied":\["a.py"\],"rejected":\["b.py:1-2"\]/);
  assert.match(observed.problems[0], /Verification stopped after saving/);
});
