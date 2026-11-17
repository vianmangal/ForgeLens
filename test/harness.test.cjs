const test = require("node:test");
const assert = require("node:assert/strict");
const { Harness } = require("../dist/trueforge/harness.js");

const created = (turnId = "t1") => ({ id: "created-" + turnId, type: "turn.created", turnId });
const done = (status = "done", fields = {}) => ({ id: "done", type: "turn.done", state: { status, ...fields } });
const paused = { id: "paused", type: "turn.update", state: { status: "paused" } };
const base = { type: "model.message", id: "msg", content: "", threadId: "main" };
const delta = content => ({ type: "model.message.delta", id: "msg", threadId: "main", content });
const toolInfo = { type: "mcp", name: "approve_hunk", serverName: "forgelens", serverId: "local" };

function call(id, hunkId, info = toolInfo) {
  return { id, type: "function", toolInfo: info, function: { name: "forgelens_approve_hunk", arguments: JSON.stringify({ hunkId }) } };
}

function approval(...ids) {
  return { type: "tool.approval_required", id: "gate", threadId: "main", toolCalls: ids.map(id => ({ id, sourceEventId: "msg" })) };
}

async function* events(...items) { yield* items; }

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function fixture(overrides = {}, hooks = {}) {
  const observed = { states: [], text: [], invalidate: [], approvals: [], decisions: [], failures: [], api: [] };
  const sessions = {
    create: async (body, options) => {
      observed.api.push(["create", body, options]);
      return { data: { id: "s1" } };
    },
    createTurnStream: async (sid, body, options) => {
      observed.api.push(["turn", sid, body, options]);
      return events(created(), base, delta("one "), delta("line"), done());
    },
    cancel: async () => {},
    ...overrides
  };
  const spec = { model: { name: "default/model", params: { temperature: 0.2 } }, instructions: "Use the connector." };
  const harness = new Harness(sessions, spec, {
    onState: state => observed.states.push(state),
    onDelta: (id, text) => observed.text.push(text),
    onInvalidate: id => observed.invalidate.push(id),
    onApproval: (...args) => observed.approvals.push(args),
    onDecision: (...args) => observed.decisions.push(args),
    ...hooks
  });
  harness.onRunFailed(failure => observed.failures.push(failure));
  return { harness, sessions, spec, observed };
}

test("fresh sessions preserve inline agent settings, include the selection and deliver real deltas", async () => {
  const { harness, observed, spec } = fixture();
  const selection = { path: "a.ts", startLine: 3, endLine: 4, text: "line", documentVersion: 2 };
  const first = await harness.startRun("primary/test", "Edit", selection);
  const second = await harness.startRun("backup/test", "Try again");
  assert.notEqual(first.runId, second.runId);
  assert.equal(first.status, "ready_to_apply");
  assert.deepEqual(observed.text, ["one ", "line", "one ", "line"]);
  const [, body, options] = observed.api[0];
  assert.deepEqual(body.agent.spec, { ...spec, model: { ...spec.model, name: "primary/test" } });
  assert.equal(spec.model.name, "default/model");
  assert.equal(options.timeoutInSeconds, 600);
  assert.equal(options.maxRetries, 0);
  assert.match(observed.api[1][2].input[0].content, /"startLine":3/);
  assert.equal(observed.api[3][2].input[0].content, "Try again");
  assert.deepEqual(observed.invalidate, [first.runId]);
  assert.equal(harness.registerProposed(first.runId, "late"), false);
});

test("correlates split tool arguments, batches two decisions, and denies unrelated, stale and duplicate calls", async () => {
  const waiting = deferred();
  const order = [];
  let submitted;
  const { harness, observed } = fixture({
    createTurnStream: async () => {
      const calls = [
        call("a", "h1"), call("wrong", "h2", { ...toolInfo, serverName: "other" }),
        call("differentTool", "h2", { ...toolInfo, name: "another_tool" }),
        call("b", "h2"), call("foreign", "stale"), call("duplicate", "h1")
      ];
      const first = structuredClone(calls[0]);
      first.function.arguments = '{"hunk';
      return events(created(), { ...base, toolCalls: [first, ...calls.slice(1)] },
        { ...delta(null), toolCalls: [{ index: 0, function: { arguments: 'Id":"h1"}' } }] },
        approval(...calls.map(c => c.id)), paused);
    },
    subscribeToTurn: async (sid, tid, cursor, opts) => {
      order.push("subscribe");
      assert.deepEqual([sid, tid, cursor, opts.timeoutInSeconds], ["s1", "t1", { afterEventId: "paused" }, 600]);
      return events(done());
    },
    createTurnEvents: async (sid, tid, { events }) => { order.push("send"); submitted = events; }
  }, { onState: state => { if (state.status === "awaiting_approval") waiting.resolve(); } });
  const finish = harness.startRun("p/m", "Do it");
  const id = harness.state.runId;
  assert.equal(harness.registerProposed("another-run", "stale"), false);
  assert.ok(harness.registerProposed(id, "h1"));
  assert.ok(harness.registerProposed(id, "h2"));
  await waiting.promise;
  assert.deepEqual(observed.approvals, [[id, "h1", "a"], [id, "h2", "b"]]);
  assert.ok(harness.approve("h1"));
  assert.equal(harness.approve("h1"), false);
  assert.equal(harness.approve("stale"), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, []);
  assert.ok(harness.reject("h2", "Keep original"));
  assert.equal((await finish).status, "ready_to_apply");
  assert.deepEqual(order, ["subscribe", "send"]);
  assert.deepEqual(submitted.map(e => [e.threadId, e.toolCallId, e.approval.status]), [
    ["main", "a", "allow"], ["main", "wrong", "deny"], ["main", "differentTool", "deny"],
    ["main", "b", "deny"], ["main", "foreign", "deny"], ["main", "duplicate", "deny"]
  ]);
  assert.equal(submitted[3].approval.reason, "Keep original");
  assert.deepEqual(observed.decisions, [[id, "h1", true], [id, "h2", false]]);
});

test("a dropped live stream replays inclusive fragments without duplicating equal tokens", async () => {
  const { harness, observed } = fixture({
    createTurnStream: async () => (async function* () {
      yield* [created(), base, delta("ha"), delta("ha")];
      throw new Error("socket closed");
    })(),
    getTurn: async () => ({ data: { state: { status: "running" } } }),
    subscribeToTurn: async (sid, tid, cursor) => {
      assert.deepEqual(cursor, { fromEventId: "msg" });
      return events(base, delta("ha"), delta("ha"), delta("!"), done());
    }
  });
  assert.equal((await harness.startRun("p/m", "hello")).status, "ready_to_apply");
  assert.deepEqual(observed.text, ["ha", "ha", "!"]);
});

test("a drop after the turn finishes replays the merged event log and emits just the missing suffix", async () => {
  const { harness, observed } = fixture({
    createTurnStream: async () => events(created(), base, delta("c")),
    getTurn: async () => ({ data: { state: { status: "done" } } }),
    listTurnEvents: async () => events(created(), { ...base, content: "cat" }, done())
  });
  assert.equal((await harness.startRun("p/m", "hello")).status, "ready_to_apply");
  assert.deepEqual(observed.text, ["c", "at"]);
});

test("sends exactly one missing-hunk follow-up in the same session and fails closed if ignored", async () => {
  const turns = [];
  const { harness, observed } = fixture({
    createTurnStream: async (sid, body) => {
      turns.push([sid, body.input[0].content]);
      return events(created("t" + turns.length), done());
    }
  });
  const finish = harness.startRun("p/m", "hello");
  harness.registerProposed(harness.state.runId, "h1");
  assert.equal((await finish).status, "failed");
  assert.equal(turns.length, 2);
  assert.equal(turns[1][0], "s1");
  assert.match(turns[1][1], /"h1"/);
  assert.equal(observed.failures[0].kind, "tool");
  assert.deepEqual(observed.invalidate, [harness.state.runId]);
});

test("cancelling during streaming invalidates immediately, ignores late messages and waits for turn.done", async () => {
  const streaming = deferred();
  const remote = deferred();
  const last = deferred();
  const { harness, observed } = fixture({
    createTurnStream: async () => (async function* () {
      yield created(); yield base; yield delta("before");
      streaming.resolve();
      await remote.promise;
      yield delta("late");
      await last.promise;
      yield done("cancelled", { reason: "user" });
    })(),
    cancel: async () => { remote.resolve(); }
  });
  const finish = harness.startRun("p/m", "hello");
  await streaming.promise;
  const result = harness.cancel();
  const id = harness.state.runId;
  assert.equal(harness.isActive(id), false);
  assert.equal(harness.registerProposed(id, "late"), false);
  assert.deepEqual(observed.invalidate, [id]);
  let drained = false;
  result.then(() => { drained = true; });
  await remote.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  last.resolve();
  await result;
  assert.equal((await finish).status, "cancelled");
  assert.deepEqual(observed.text, ["before"]);
  assert.deepEqual(observed.failures.map(f => f.kind), ["cancelled"]);
});

test("cancelling while paused drains the same turn and never submits a late approval", async () => {
  const waiting = deferred();
  let sends = 0;
  const { harness, observed } = fixture({
    createTurnStream: async () => events(created(), { ...base, toolCalls: [call("a", "h")] }, approval("a"), paused),
    cancel: async () => {},
    getTurn: async () => ({ data: { state: { status: "cancelled" } } }),
    listTurnEvents: async () => events(created(), { ...base, content: "late" }, done("cancelled", { reason: "user" })),
    createTurnEvents: async () => { sends++; }
  }, { onState: state => { if (state.status === "awaiting_approval") waiting.resolve(); } });
  const finish = harness.startRun("p/m", "hello");
  harness.registerProposed(harness.state.runId, "h");
  await waiting.promise;
  const result = harness.cancel();
  assert.equal(harness.approve("h"), false);
  await result;
  assert.equal((await finish).status, "cancelled");
  assert.equal(sends, 0);
  assert.deepEqual(observed.text, []);
  assert.equal(harness.state.lastEventId, "done");
});

for (const [message, kind] of [["401 invalid key", "auth"], ["HTTP 503", "server"], ["connection timed out", "network"], ["malformed tool response", "tool"]]) {
  test("classifies terminal errors for fallback: " + kind, async () => {
    const { harness, observed } = fixture({ createTurnStream: async () => events(created(), done("error", { message })) });
    const finish = await harness.startRun("p/m", "hello");
    assert.deepEqual(observed.failures, [{ runId: finish.runId, model: "p/m", kind, message }]);
    assert.deepEqual(observed.invalidate, [finish.runId]);
    assert.equal(finish.status, "failed");
  });
}

test("a review left pending resumes the same turn", async () => {
  const waiting = deferred();
  const decisions = [];
  const { harness } = fixture({
    createTurnStream: async () => events(created(), { ...base, toolCalls: [call("a", "h")] }, approval("a"), paused),
    subscribeToTurn: async () => events(done()),
    createTurnEvents: async (sid, tid, { events }) => decisions.push([sid, tid, events[0].approval.status])
  }, { onState: state => { if (state.status === "awaiting_approval") waiting.resolve(); } });
  const finish = harness.startRun("p/m", "demo");
  harness.registerProposed(harness.state.runId, "h");
  await waiting.promise;
  const waitMs = Number(process.env.FORGELENS_TEST_REVIEW_WAIT_MS || 0);
  await new Promise(resolve => setTimeout(resolve, waitMs));
  assert.equal(harness.state.status, "awaiting_approval");
  assert.deepEqual(decisions, []);
  assert.ok(harness.approve("h"));
  assert.equal((await finish).status, "ready_to_apply");
  assert.deepEqual(decisions, [["s1", "t1", "allow"]]);
});

test("a terminal event with an unanswered gate never marks the run ready", async () => {
  const { harness, observed } = fixture({
    createTurnStream: async () => events(created(), { ...base, toolCalls: [call("a", "h")] }, approval("a"), done())
  });
  const finish = harness.startRun("p/m", "demo");
  harness.registerProposed(harness.state.runId, "h");
  assert.equal((await finish).status, "failed");
  assert.match(observed.failures[0].message, /before its hunk approval/);
});

test("installed SDK serializes a gated turn and parses wire-format SSE on its session endpoints", async () => {
  const { TrueForge } = await import("@truefoundry/trueforge-sdk");
  const spec = { model: { name: "fixture/start" }, mcpServers: [{ name: "forgelens", requireApprovalForTools: ["approve_hunk"] }] };
  const now = new Date().toISOString();
  const trace = [];
  const text = [];
  const failures = [];
  const waiting = deferred();
  const sse = frames => new Response(frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join(""), {
    headers: { "content-type": "text/event-stream" }
  });
  const transport = async (input, init) => {
    const url = new URL(input);
    const body = init.body && JSON.parse(init.body);
    trace.push([init.method, url.pathname, url.search, body]);
    switch (url.pathname) {
      case "/api/v1/sessions":
        return Response.json({ data: { id: "s", agent: { type: "inline", spec: body.agent.spec },
          created_at: now, updated_at: now, metadata: {}, title: null, source: null, last_turn_details: null,
          metrics: { total_duration_ms: 0, total_turns: 0 },
          created_by_subject: { subject_type: "user", subject_id: "user", subject_display_name: "User" } } });
      case "/api/v1/sessions/s/turns":
        return sse([
          { type: "turn.created", previous_turn_id: null, turn_id: "t", id: "begin", created_at: now, thread_id: null, state: { status: "running" } },
          { type: "model.message", id: "m", created_at: now, thread_id: "main", content: "",
            tool_calls: [{ id: "call", type: "function", tool_info: { name: "approve_hunk", type: "mcp", server_name: "forgelens", server_id: "fs" },
              function: { name: "fs_approve_hunk", arguments: '{"hunkId":"h"}' } }] },
          { type: "model.message.delta", id: "m", thread_id: "main", content: "Review" },
          { type: "tool.approval_required", id: "gate", created_at: now, thread_id: "main", tool_calls: [{ id: "call", source_event_id: "m" }] },
          { type: "turn.update", id: "pause", created_at: now, thread_id: null, state: { status: "paused" } }
        ]);
      case "/api/v1/sessions/s/turns/t/subscribe":
        return sse([{ type: "turn.done", id: "end", created_at: now, thread_id: null,
          state: { status: "done", completed_at: now, output: null, required_actions: [] } }]);
      case "/api/v1/sessions/s/turns/t/events":
        return Response.json({ data: body.events.map(event => ({ ...event, id: "decision", created_at: now })) });
      default:
        throw new Error("Unexpected local SDK route " + url.pathname);
    }
  };
  const client = new TrueForge({ baseUrl: "http://127.0.0.1:8790", fetch: transport, timeoutInSeconds: 600 });
  const harness = new Harness(client.sessions, spec, {
    onState: state => { if (state.status === "awaiting_approval") waiting.resolve(); },
    onDelta: (id, value) => text.push(value)
  });
  harness.onRunFailed(reason => failures.push(reason));
  const finish = harness.startRun("fixture/override", "Review this change");
  harness.registerProposed(harness.state.runId, "h");
  await Promise.race([waiting.promise, finish]);
  assert.deepEqual(failures, []);
  assert.ok(harness.reject("h", "Keep it"));
  assert.equal((await finish).status, "ready_to_apply");
  assert.deepEqual(text, ["Review"]);
  assert.deepEqual(trace.map(([method, path, query]) => [method, path, query]), [
    ["POST", "/api/v1/sessions", ""], ["POST", "/api/v1/sessions/s/turns", ""],
    ["GET", "/api/v1/sessions/s/turns/t/subscribe", "?after_event_id=pause"],
    ["POST", "/api/v1/sessions/s/turns/t/events", ""]
  ]);
  assert.equal(trace[0][3].agent.spec.model.name, "fixture/override");
  assert.deepEqual(trace[0][3].agent.spec.mcp_servers[0].require_approval_for_tools, ["approve_hunk"]);
  assert.equal(trace[1][3].stream, true);
  assert.deepEqual(trace[3][3].events, [{ type: "user.tool_approval", thread_id: "main", tool_call_id: "call",
    approval: { status: "deny", reason: "Keep it" } }]);
});

test("a reminder can finish review on a second turn with the original staged hunk", async () => {
  let turns = 0;
  const { harness, observed } = fixture({
    createTurnStream: async () => {
      if (++turns === 1) return events(created("t1"), done());
      return events(created("t2"), { ...base, toolCalls: [call("a", "h")] }, approval("a"), paused);
    },
    subscribeToTurn: async (sid, tid) => { assert.equal(tid, "t2"); return events(done()); },
    createTurnEvents: async (sid, tid) => { assert.equal(tid, "t2"); }
  }, { onApproval: (_, id) => { assert.ok(harness.approve(id)); } });
  const finish = harness.startRun("p/m", "demo");
  harness.registerProposed(harness.state.runId, "h");
  const state = await finish;
  assert.equal(state.status, "ready_to_apply");
  assert.equal(state.turnId, "t2");
  assert.equal(turns, 2);
  assert.deepEqual(observed.decisions, [[state.runId, "h", true]]);
});

test("cancel while opening a session prevents a late model turn from starting", async () => {
  const opening = deferred();
  const cancelled = [];
  const { harness } = fixture({
    create: async () => { await opening.promise; return { data: { id: "s" } }; },
    createTurnStream: () => { assert.fail("no turn may start after invalidation"); },
    cancel: async sid => cancelled.push(sid)
  });
  const finish = harness.startRun("p/m", "demo");
  const stopping = harness.cancel();
  assert.equal(harness.state.status, "cancelled");
  opening.resolve();
  await stopping;
  assert.deepEqual(cancelled, ["s"]);
  assert.equal((await finish).status, "cancelled");
});

test("losing the stream before its first frame recovers the accepted turn without sending the instruction twice", async () => {
  let creates = 0;
  const { harness, observed } = fixture({
    createTurnStream: async () => { creates++; return events(); },
    get: async sid => { assert.equal(sid, "s1"); return { data: { lastTurnDetails: { id: "new-turn" } } }; },
    getTurn: async () => ({ data: { state: { status: "done" } } }),
    listTurnEvents: async (sid, tid) => {
      assert.equal(tid, "new-turn");
      return events(created("new-turn"), { ...base, content: "answer" }, done());
    }
  });
  assert.equal((await harness.startRun("p/m", "demo")).status, "ready_to_apply");
  assert.equal(creates, 1);
  assert.deepEqual(observed.text, ["answer"]);
});
