const vscode = acquireVsCodeApi();
const el = id => document.getElementById(id);
let runId;
el("form").onsubmit = event => {
  event.preventDefault();
  const text = el("task").value.trim();
  if (text) vscode.postMessage({ type: "run", text });
};
el("cancel").onclick = () => vscode.postMessage({ type: "cancel", runId });
const cards = new Map();
const contextCards = new Map();
function updateCards(rows) {
  for (const [id, card] of cards) {
    if (!rows.some(row => row.hunkId === id)) { card.remove(); cards.delete(id); }
  }
  for (const row of rows) {
    let card = cards.get(row.hunkId);
    if (!card) {
      card = document.createElement("article");
      const title = document.createElement("strong");
      title.textContent = "Hunk " + row.hunkId;
      card.append(title);
      if (row.detail) {
        const code = document.createElement("pre");
        code.textContent = "− " + row.detail.oldText + "\n+ " + row.detail.newText;
        card.append(code);
      }
      const feedback = document.createElement("p");
      card.append(feedback);
      for (const allow of (row.detail ? [true, false] : [])) {
        const button = document.createElement("button");
        button.textContent = allow ? "Accept" : "Reject";
        button.onclick = () => vscode.postMessage({ type: "decision", runId, hunkId: row.hunkId, allow });
        card.append(button);
      }
      cards.set(row.hunkId, card);
      el("approvals").append(card);
    }
    card.querySelector("p").textContent = { pending: row.detail ? "Awaiting your decision" : "Review this hunk in the editor.", sending: "Sending decision…",
      accepted: "Accepted", rejected: "Rejected" }[row.status];
    card.querySelectorAll("button").forEach(button => { button.disabled = row.status !== "pending"; });
  }
}
const reviewFiles = new Map();
const reviewHunks = new Map();
function updateReview(hunks) {
  const counts = new Map();
  const ids = new Set();
  for (const hunk of hunks) {
    ids.add(hunk.id);
    counts.set(hunk.path, (counts.get(hunk.path) || 0) + 1);
    let group = reviewFiles.get(hunk.path);
    if (!group) {
      group = document.createElement("section");
      group.append(document.createElement("h3"));
      reviewFiles.set(hunk.path, group);
      el("review-files").append(group);
    }
    let row = reviewHunks.get(hunk.id);
    if (!row) {
      row = document.createElement("article");
      for (const action of ["open", "accept", "reject"]) {
        const button = document.createElement("button");
        button.textContent = action === "open" ? "Open diff · line " + hunk.startLine : action === "accept" ? "Accept" : "Reject";
        button.onclick = () => vscode.postMessage({ type: "review", runId, action, hunkId: hunk.id });
        row.append(button);
      }
      row.append(document.createElement("span"));
      reviewHunks.set(hunk.id, row);
      group.append(row);
    }
    row.lastElementChild.textContent = " " + hunk.status.replace(/_/g, " ");
    const [open, accept, reject] = row.querySelectorAll("button");
    open.disabled = hunk.status === "invalidated";
    accept.disabled = reject.disabled = hunk.status !== "approval_requested";
  }
  for (const [id, row] of reviewHunks) {
    if (!ids.has(id)) { row.remove(); reviewHunks.delete(id); }
  }
  for (const [path, group] of reviewFiles) {
    if (counts.has(path)) group.firstElementChild.textContent = path + " (" + counts.get(path) + ")";
    else { group.remove(); reviewFiles.delete(path); }
  }
}
// Shows retrieval cost and lets the developer open the cited workspace range.
function updateContextRows(rows) {
  const section = el("context-section");
  const container = el("context-rows");
  section.hidden = !rows.length;
  const currentKeys = new Set();
  for (const row of rows) {
    const key = JSON.stringify([row.runId, row.tool, row.query, row.path, row.startLine, row.endLine, row.cumulativeTokens]);
    currentKeys.add(key);
    let entry = contextCards.get(key);
    if (!entry) {
      const card = document.createElement("article");
      const title = document.createElement("strong");
      const detail = document.createElement("p");
      const cost = document.createElement("p");
      const button = document.createElement("button");
      button.textContent = "Open source";
      button.onclick = () => vscode.postMessage({
        type: "openContext",
        runId,
        path: row.path,
        startLine: row.startLine,
        endLine: row.endLine
      });
      card.append(title, detail, cost, button);
      entry = { card, title, detail, cost, button };
      contextCards.set(key, entry);
    }
    entry.title.textContent = row.path + ":" + row.startLine + "-" + row.endLine;
    entry.detail.textContent = row.tool + " · " + row.query + " · " + row.signal;
    const state = row.sentToModel
      ? row.exclusion === "truncated" ? "sent (truncated)" : "sent"
      : row.exclusion === "result_limit" ? row.omittedMatches + " omitted at result limit"
      : row.exclusion === "duplicate" ? "already included" : "excluded: " + (row.exclusion || "not sent");
    entry.cost.textContent = row.costTokens + " estimated source tokens · " + row.cumulativeTokens +
      (typeof row.limitTokens === "number" ? " of " + row.limitTokens : "") + " used this run · " + state;
    entry.button.hidden = !row.path || row.startLine <= 0;
    if (entry.card.parentElement !== container) container.append(entry.card);
  }
  for (const [key, entry] of contextCards) {
    if (currentKeys.has(key)) continue;
    entry.card.remove();
    contextCards.delete(key);
  }
}

window.addEventListener("message", ({ data }) => {
  if (data.type === "delta" && data.runId === runId) {
    el("reply-section").hidden = false;
    el("reply").append(document.createTextNode(data.text));
  }
  if (data.type !== "view") return;
  runId = data.state?.runId;
  const status = data.state?.status;
  const active = status === "streaming" || status === "awaiting_approval";
  el("run").disabled = active;
  el("cancel").hidden = !active;
  const labels = { streaming: "Streaming", awaiting_approval: "Awaiting approval", ready_to_apply: "Run complete",
    cancelled: "Cancelled", failed: "Failed", applied: "Applied", fell_back: "Using backup" };
  el("status").textContent = status ? labels[status] + " · " + data.state.model : "";
  el("error").textContent = data.error;
  el("reply-section").hidden = !data.text;
  el("reply").textContent = data.text;
  updateCards(data.rows);
  updateReview(data.reviewHunks || []);
  updateContextRows(data.contextRows || []);
});
vscode.postMessage({ type: "ready" });
