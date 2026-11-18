const test = require("node:test");
const assert = require("node:assert/strict");
const { applyHunks, buildProposal, computeHunks, hunksOverlap, mappedStartLine, validateHunk } = require("../dist/review/hunks.js");

const base = [
  "def get_flag():",
  "    val = os.environ.get(\"X\")",
  "    if not val:",
  "        return False",
  "    return val.lower() not in (\"0\", \"false\", \"no\")",
  "",
  "def other():",
  "    return 1",
  ""
].join("\n");

test("two separated changes become two hunks that apply cleanly", () => {
  const next = base
    .replace("def get_flag():\n", "def get_flag():\n    \"\"\"Doc.\"\"\"\n")
    .replace("(\"0\", \"false\", \"no\")", "(\"0\", \"false\", \"no\", \"off\", \"n\")");
  const hunks = computeHunks(base, next);
  assert.equal(hunks.length, 2);
  for (const h of hunks) assert.ok(validateHunk(base, h));
  assert.equal(applyHunks(base, hunks), next);
});

test("applying only one hunk keeps the other line unchanged", () => {
  const next = base.replace("def get_flag():\n", "def get_flag():\n    \"\"\"Doc.\"\"\"\n").replace("return 1", "return 2");
  const hunks = computeHunks(base, next);
  assert.equal(hunks.length, 2);
  const onlySecond = applyHunks(base, [hunks[1]]);
  assert.ok(onlySecond.includes("return 2"));
  assert.ok(!onlySecond.includes("Doc."));
});

test("range proposal adds a missing trailing newline and maps to file lines", () => {
  const result = buildProposal(base, { kind: "range", startLine: 7, endLine: 8, newText: "def other():\n    return 42" }, []);
  assert.equal(result.ok, true);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].startLine, 8);
  assert.equal(applyHunks(base, result.hunks), base.replace("return 1", "return 42"));
});

test("anchor proposals must be unique and may be mid-line", () => {
  const dup = base + "def x():\n    return 1\n";
  assert.equal(buildProposal(dup, { kind: "anchor", oldText: "    return 1\n", newText: "    return 3\n" }, []).ok, false);
  const mid = buildProposal(base, { kind: "anchor", oldText: "\"no\")", newText: "\"no\", \"off\")" }, []);
  assert.equal(mid.ok, true);
  assert.equal(applyHunks(base, mid.hunks), base.replace("\"no\")", "\"no\", \"off\")"));
});

test("overlapping proposals are rejected and separate ones accepted", () => {
  const first = buildProposal(base, { kind: "range", startLine: 2, endLine: 3, newText: "    a\n    b\n" }, []);
  assert.equal(first.ok, true);
  assert.equal(buildProposal(base, { kind: "range", startLine: 3, endLine: 4, newText: "    c\n" }, first.hunks).ok, false);
  assert.equal(buildProposal(base, { kind: "range", startLine: 8, endLine: 8, newText: "    return 5\n" }, first.hunks).ok, true);
});

test("insertions, deletions, missing final newline and CRLF", () => {
  const ins = computeHunks("a\nb\n", "a\nx\nb\n");
  assert.equal(ins[0].endLine, ins[0].startLine - 1);
  assert.equal(applyHunks("a\nb\n", ins), "a\nx\nb\n");
  assert.equal(applyHunks("a\nx\nb\n", computeHunks("a\nx\nb\n", "a\nb\n")), "a\nb\n");
  assert.equal(applyHunks("a\nb", computeHunks("a\nb", "a\nc")), "a\nc");
  const crlf = "a\r\nb\r\nc\r\n";
  const r = buildProposal(crlf, { kind: "range", startLine: 2, endLine: 2, newText: "B\n" }, []);
  assert.equal(applyHunks(crlf, r.hunks), "a\r\nB\r\nc\r\n");
});

test("mapped start lines and same-point inserts", () => {
  const hunks = computeHunks("a\nb\nc\n", "a\nnew1\nnew2\nb\nc\nC2\n");
  assert.equal(mappedStartLine(hunks[1], hunks), hunks[1].startLine + 2);
  const a = { startLine: 2, endLine: 1, oldText: "", newText: "x\n" };
  const b = { startLine: 2, endLine: 1, oldText: "", newText: "y\n" };
  assert.ok(hunksOverlap("a\nb\n", a, b));
});

test("inserting after the last line of a file without a final newline starts a new line", () => {
  const lf = buildProposal("a\nb", { kind: "range", startLine: 3, endLine: 2, newText: "x\n" }, []);
  assert.equal(lf.ok, true);
  assert.equal(applyHunks("a\nb", lf.hunks), "a\nb\nx\n");
  const crlf = buildProposal("a\r\nb", { kind: "range", startLine: 3, endLine: 2, newText: "x" }, []);
  assert.equal(applyHunks("a\r\nb", crlf.hunks), "a\r\nb\r\nx");
  assert.equal(applyHunks("a\nb\n", buildProposal("a\nb\n", { kind: "range", startLine: 3, endLine: 2, newText: "x\n" }, []).hunks), "a\nb\nx\n");
  assert.equal(buildProposal("a\nb", { kind: "range", startLine: 3, endLine: 2, newText: "" }, []).ok, false);
});
