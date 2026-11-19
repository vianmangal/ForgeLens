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
// Shows retrieval cost and lets the developer open the cited workspace range.
function updateContextRows(rows) {
  const section = el("context-section");
  const container = el("context-rows");
  container.replaceChildren();
  section.hidden = !rows.length;
  for (const row of rows) {
    const card = document.createElement("article");
    const title = document.createElement("strong");
    title.textContent = row.path + ":" + row.startLine + "-" + row.endLine;
    const detail = document.createElement("p");
    detail.textContent = row.tool + " · " + row.query + " · " + row.signal;
    const cost = document.createElement("p");
    cost.textContent = row.costTokens + " tokens · " + row.cumulativeTokens + " total" +
      (row.exclusion ? " · excluded: " + row.exclusion : row.sentToModel ? "" : " · excluded: not sent");
    card.append(title, detail, cost);
    if (row.path && row.startLine > 0) {
      const button = document.createElement("button");
      button.textContent = "Open source";
      button.onclick = () => vscode.postMessage({
        type: "openContext",
        runId,
        path: row.path,
        startLine: row.startLine,
        endLine: row.endLine
      });
      card.append(button);
    }
    container.append(card);
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
  updateContextRows(data.contextRows || []);
});
vscode.postMessage({ type: "ready" });
