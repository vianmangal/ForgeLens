const assert = require("node:assert/strict");
const test = require("node:test");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { ProofFixture, proofSpec } = require("../dist/proof/connector.js");
const file = join(__dirname, "..", "fixtures", "proof.txt");

test("a proof leases one fixture line, idempotently stages one hunk and keeps the file intact", async () => {
  let active = true;
  const registered = new Set();
  const f = new ProofFixture(() => readFile(file, "utf8"), () => active, id => { registered.add(id); return active; });
  const before = await readFile(file, "utf8");
  await assert.rejects(f.read("../proof.txt", 2, 2));
  await assert.rejects(f.read(f.path, 1, 3));
  const read = await f.read(f.path, 2, 2);
  assert.equal(read.text, before.split("\n")[1]);
  assert.throws(() => f.propose("old-snapshot", "replacement"));
  const { hunkIds: [id] } = f.propose(read.snapshotId, "replacement");
  assert.ok(registered.has(id));
  assert.deepEqual(f.propose(read.snapshotId, "replacement").hunkIds, [id]);
  assert.throws(() => f.acknowledge("some-other-id"));
  assert.equal(f.acknowledge(id).hunkId, id);
  active = false;
  assert.throws(() => f.acknowledge(id));
  assert.throws(() => f.propose(read.snapshotId, "replacement"));
  assert.equal(await readFile(file, "utf8"), before);
});

test("the proof connector has its own approval policy without replacing the team connector", () => {
  const agent = require("../agent/forgelens.agent.json");
  const proof = proofSpec(agent);
  assert.equal(agent.mcpServers[0].name, "forgelens");
  assert.equal(proof.mcpServers[0].name, "forgelens-proof");
  assert.deepEqual(proof.mcpServers[0].requireApprovalForTools, ["approve_hunk"]);
  assert.ok(!agent.mcpServers[0].preloadTools.includes("run_check"));
});
