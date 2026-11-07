"use strict";

// All conversation state lives here in the browser — the backend keeps none.
// Every turn sends the full message history to /api/ask.
const state = {
  messages: [], // OpenAI chat format: [{role: "user"|"assistant", content}]
  pending: false,
};

const chatEl = document.getElementById("chat");
const composerEl = document.getElementById("composer");
const questionEl = document.getElementById("question");
const sendBtn = document.getElementById("send");
const newChatBtn = document.getElementById("new-chat");

composerEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = questionEl.value.trim();
  if (!question || state.pending) return;
  questionEl.value = "";
  autoGrow(questionEl);
  ask(question);
});

questionEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composerEl.requestSubmit();
  }
});

questionEl.addEventListener("input", () => autoGrow(questionEl));

newChatBtn.addEventListener("click", () => {
  if (state.pending) return;
  state.messages = [];
  chatEl.replaceChildren();
  setLanding(true);
  questionEl.focus();
});

// Landing state: no conversation yet — the composer sits centered on the
// page; it docks to the bottom once the chat starts.
function setLanding(on) {
  document.body.classList.toggle("landing", on);
}
setLanding(true);

// Clicking an inline citation marker [1](#ref-xyz) scrolls to the matching
// entry in the bibliography rendered at the bottom of the answer. Hovering
// shows a popup with the citation's details.
const citationMaps = new WeakMap(); // assistant bubble -> {citationId: citation}

const tooltipEl = document.createElement("div");
tooltipEl.id = "citation-tooltip";
document.body.appendChild(tooltipEl);

chatEl.addEventListener("mouseover", (event) => {
  const link = event.target.closest('a[href^="#ref-"]');
  if (link) showCitationTooltip(link);
});
chatEl.addEventListener("mouseout", (event) => {
  if (event.target.closest('a[href^="#ref-"]')) hideCitationTooltip();
});
window.addEventListener("scroll", hideCitationTooltip, true);

function showCitationTooltip(link) {
  const bubble = link.closest(".bubble.assistant");
  const map = bubble && citationMaps.get(bubble);

  tooltipEl.replaceChildren();
  const title = document.createElement("div");
  title.className = "ct-title";

  if (!map) {
    // Still streaming — citations only land on the final chunk.
    title.textContent = "Citation details arrive when the answer completes.";
  } else {
    const id = link.getAttribute("href").replace(/^#ref-/, "");
    const citation = map.byId[id];
    const number = map.anchorIds.indexOf(id) + 1;
    if (citation) {
      title.textContent = `[${number}] ${citation.title || citation.url || citation.id}`;
      const source = citationSourceLabel(citation);
      if (source) {
        const sourceEl = document.createElement("div");
        sourceEl.className = "ct-source";
        sourceEl.textContent = source;
        tooltipEl.appendChild(sourceEl);
      }
      if (citation.passage) {
        const passage = document.createElement("div");
        passage.className = "ct-passage";
        passage.textContent = citation.passage;
        tooltipEl.appendChild(passage);
      }
      if (citation.url) {
        const url = document.createElement("div");
        url.className = "ct-url";
        url.textContent = citation.url;
        tooltipEl.appendChild(url);
      }
    } else {
      title.textContent = `[${number}] No source details were provided for this citation.`;
    }
  }
  tooltipEl.prepend(title);
  tooltipEl.style.display = "block";

  const rect = link.getBoundingClientRect();
  const { offsetWidth: tw, offsetHeight: th } = tooltipEl;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = rect.top - th - 8;
  if (top < 8) top = rect.bottom + 8;
  tooltipEl.style.left = left + "px";
  tooltipEl.style.top = top + "px";
}

function hideCitationTooltip() {
  tooltipEl.style.display = "none";
}

// Citation payloads carry journal/year (plus pmid/passage); older environments
// sent a plain "source" string instead.
function citationSourceLabel(citation) {
  if (citation.source) return citation.source;
  return [citation.journal, citation.year].filter(Boolean).join(" · ");
}

chatEl.addEventListener("click", (event) => {
  const link = event.target.closest('a[href^="#ref-"]');
  if (!link) return;
  event.preventDefault();
  const id = link.getAttribute("href").slice("ref-".length + 1);
  const target = chatEl.querySelector(`li[data-anchor="${CSS.escape(id)}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1200);
});

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 300) + "px";
}

async function ask(question) {
  state.pending = true;
  sendBtn.disabled = true;
  setLanding(false);

  state.messages.push({ role: "user", content: question });
  appendMessage("user", question);

  const assistant = appendAssistantBubble();

  let response;
  try {
    response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: state.messages, stream: true }),
    });
  } catch (err) {
    failTurn(assistant, "Could not reach the server. Is the backend running?");
    return;
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      payload && payload.error && payload.error.message
        ? payload.error.message
        : `Request failed with status ${response.status}`;
    failTurn(assistant, message);
    return;
  }

  const turn = { answer: "", reasoning: "", citations: null, error: null };
  const parser = createSSEParser((eventName, data) =>
    handleFrame(turn, assistant, eventName, data),
  );

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (value) parser.feed(decoder.decode(value, { stream: true }));
      if (done) break;
    }
    parser.flush();
  } catch (err) {
    turn.error = "The connection to the server was interrupted.";
  }

  finishTurn(turn, assistant);
}

function handleFrame(turn, assistant, eventName, data) {
  if (data === "[DONE]") return;
  let chunk;
  try {
    chunk = JSON.parse(data);
  } catch (err) {
    return;
  }
  if (chunk.error) {
    turn.error = chunk.error.message || "The Ask API reported an error.";
    return;
  }
  // Citations arrive as their own named SSE event ("event: citation") carrying
  // a chat.completion.citation object — not as an array on the final chunk.
  if (eventName === "citation" || chunk.object === "chat.completion.citation") {
    if (!Array.isArray(turn.citations)) turn.citations = [];
    turn.citations.push(chunk);
    return;
  }
  if (eventName === "artifact" || chunk.object === "chat.completion.artifact") {
    renderArtifact(assistant.artifactsEl, chunk);
    return;
  }
  const choice = chunk.choices && chunk.choices[0];
  if (!choice) return;
  const delta = choice.delta || {};
  if (delta.reasoning_content) {
    turn.reasoning = turn.reasoning
      ? turn.reasoning + "\n" + delta.reasoning_content
      : delta.reasoning_content;
    renderReasoning(assistant.reasoningEl, turn.reasoning, Boolean(turn.answer));
  }
  if (delta.content) {
    const answerStarted = Boolean(turn.answer);
    turn.answer += delta.content;
    renderAnswer(assistant.contentEl, turn.answer);
    if (!answerStarted) collapseReasoning(assistant.reasoningEl);
  }
  // Citations ride on the final chunk (finish_reason: "stop").
  if (choice.finish_reason === "stop") {
    const citations = choice.citations || chunk.citations;
    if (citations) turn.citations = citations;
  }
}

function finishTurn(turn, assistant) {
  state.pending = false;
  sendBtn.disabled = false;
  if (turn.error || !turn.answer) {
    failTurn(assistant, turn.error || "The Ask API returned an empty answer.");
    return;
  }
  // Follow-up turns replay this history; only the answer prose is kept.
  state.messages.push({ role: "assistant", content: turn.answer });
  collapseReasoning(assistant.reasoningEl);

  // Build the bibliography from the inline #ref- anchors. Source details
  // (title/url/source) may be absent — some Ask API environments don't send
  // a citations array yet.
  const byId = {};
  for (const citation of turn.citations || []) byId[citation.id] = citation;
  const anchorIds = [];
  for (const match of turn.answer.matchAll(/#ref-([A-Za-z0-9_-]+)/g)) {
    if (!anchorIds.includes(match[1])) anchorIds.push(match[1]);
  }
  citationMaps.set(assistant.bubbleEl, { byId, anchorIds });
  if (anchorIds.length) {
    renderCitations(assistant.footerEl, byId, anchorIds);
  }
  questionEl.placeholder = "Ask a follow-up question…";
  scrollBottom();
  questionEl.focus();
}

function failTurn(assistant, message) {
  state.pending = false;
  sendBtn.disabled = false;
  // No answer was produced — drop the dangling user turn so the history
  // replayed on the next request stays valid.
  state.messages.pop();
  assistant.bubbleEl.classList.add("error");
  assistant.contentEl.textContent = message;
  scrollBottom();
  questionEl.focus();
}

function appendMessage(role, text) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  chatEl.appendChild(bubble);
  scrollBottom();
  return bubble;
}

function appendAssistantBubble() {
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant";

  const reasoningEl = document.createElement("div");
  reasoningEl.className = "reasoning";

  const contentEl = document.createElement("div");
  contentEl.className = "answer";

  const artifactsEl = document.createElement("div");
  artifactsEl.className = "artifacts";

  const footerEl = document.createElement("div");
  footerEl.className = "assistant-footer";

  bubble.append(reasoningEl, contentEl, artifactsEl, footerEl);
  chatEl.appendChild(bubble);
  scrollBottom();
  return { bubbleEl: bubble, reasoningEl, contentEl, artifactsEl, footerEl };
}

function renderReasoning(container, text, answerStarted) {
  container.classList.add("visible");
  const details = document.createElement("details");
  details.className = "reasoning-details";
  details.open = !answerStarted;
  const summary = document.createElement("summary");
  summary.textContent = answerStarted ? "Research notes" : "Researching…";
  const body = document.createElement("div");
  body.className = "reasoning-body";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const item = document.createElement("div");
    item.className = "reasoning-line";
    item.textContent = line.replace(/^\*+|\*+$/g, "").trim();
    body.appendChild(item);
  }
  details.append(summary, body);
  container.replaceChildren(details);
  scrollBottom();
}

function collapseReasoning(container) {
  const details = container.querySelector("details");
  if (!details) return;
  details.open = false;
  const summary = details.querySelector("summary");
  if (summary) summary.textContent = "Research notes";
}

function renderAnswer(contentEl, answer) {
  if (window.marked && window.DOMPurify) {
    try {
      contentEl.innerHTML = DOMPurify.sanitize(marked.parse(answer));
    } catch (err) {
      contentEl.textContent = answer;
    }
  } else {
    contentEl.textContent = answer;
  }
  scrollBottom();
}

function renderCitations(footerEl, byId, anchorIds) {
  // anchorIds are ordered by first appearance in the answer, which matches
  // the inline [n](#ref-…) numbering.
  const heading = document.createElement("div");
  heading.className = "citations-heading";
  heading.textContent = "Sources";

  const list = document.createElement("ol");
  list.className = "citations";
  for (const id of anchorIds) {
    const citation = byId[id];
    const item = document.createElement("li");
    item.dataset.anchor = id;
    if (citation && (citation.title || citation.url)) {
      const link = document.createElement("a");
      if (citation.url) {
        link.href = citation.url;
        link.target = "_blank";
        link.rel = "noopener";
      } else {
        link.href = `#ref-${id}`;
        link.addEventListener("click", (event) => event.preventDefault());
      }
      link.textContent = citation.title || citation.url;
      item.appendChild(link);
      const source = citationSourceLabel(citation);
      if (source) {
        const sourceEl = document.createElement("span");
        sourceEl.className = "citation-source";
        sourceEl.textContent = source;
        item.appendChild(sourceEl);
      }
    } else {
      const missing = document.createElement("span");
      missing.className = "citation-missing";
      missing.textContent = "Source details not provided by the API";
      item.appendChild(missing);
    }
    list.appendChild(item);
  }
  footerEl.replaceChildren(heading, list);
}

function renderArtifact(container, artifact) {
  if (artifact.type === "drug_dose") {
    renderDrugDoseGrouped(container, artifact.data || {});
    scrollBottom();
    return;
  }

  const card = document.createElement("div");
  card.className = `artifact artifact-${artifact.type}`;
  const data = artifact.data || {};

  if (artifact.type === "drug_interaction") {
    renderDrugInteraction(card, data);
  } else if (artifact.type === "dose_check") {
    renderDoseCheck(card, data);
  } else if (artifact.type === "drug_pill_images") {
    renderPillImages(card, data);
  } else if (artifact.type === "generated_image") {
    card.classList.add("generated-image");
    const img = document.createElement("img");
    img.alt = "Image generated for this answer";
    img.src = `data:${data.mime_type};base64,${data.b64_json}`;
    card.appendChild(img);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(artifact, null, 2);
    card.appendChild(pre);
  }
  container.appendChild(card);
  scrollBottom();
}

function artifactTitle(card, text, badgeSeverity) {
  const title = document.createElement("div");
  title.className = "artifact-title";
  title.textContent = text;
  if (badgeSeverity) {
    const badge = document.createElement("span");
    badge.className = `badge severity-${badgeSeverity}`;
    badge.textContent = badgeSeverity;
    title.appendChild(badge);
  }
  card.appendChild(title);
  return title;
}

const DOSE_COLUMNS = ["Indication", "Amount", "Unit", "Route", "Frequency"];

function renderDrugDoseGrouped(container, data) {
  if (!container.__doseGroups) container.__doseGroups = new Map();
  const displayName = data.drug?.name || "unknown";
  const key = displayName.trim().toLowerCase();
  let group = container.__doseGroups.get(key);
  if (!group) {
    const card = document.createElement("div");
    card.className = "artifact artifact-drug_dose";
    artifactTitle(card, `Drug dose — ${displayName}`);
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const label of DOSE_COLUMNS) {
      const th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    }
    const sourcesEl = document.createElement("div");
    sourcesEl.className = "artifact-sources";
    card.appendChild(table);
    card.appendChild(sourcesEl);
    container.appendChild(card);
    group = { tbody: table.createTBody(), sourcesEl, sources: new Set() };
    container.__doseGroups.set(key, group);
  }
  for (const regimen of Array.isArray(data.regimens) ? data.regimens : []) {
    const row = group.tbody.insertRow();
    for (const value of [
      data.indication || "",
      regimen.amount ?? "",
      regimen.unit ?? "",
      regimen.route ?? "",
      regimen.frequency ?? ""
    ]) {
      row.insertCell().textContent = value;
    }
  }
  for (const source of Array.isArray(data.sources) ? data.sources : []) {
    group.sources.add(`${source.section || "source"} (${source.citation_id})`);
  }
  if (group.sources.size) {
    group.sourcesEl.textContent = Array.from(group.sources).join(" · ");
  }
}

function renderDrugInteraction(card, data) {
  const drugNames = (data.drugs || []).map((drug) => drug.name).join(" + ");
  artifactTitle(card, `Interaction — ${drugNames}`, data.severity);
  if (data.effect) {
    const p = document.createElement("p");
    p.textContent = data.effect;
    card.appendChild(p);
  }
  if (data.management) {
    const p = document.createElement("p");
    p.textContent = `Management: ${data.management}`;
    card.appendChild(p);
  }
  renderArtifactSources(card, data.sources);
}

function renderDoseCheck(card, data) {
  const statements = Array.isArray(data.statements) ? data.statements : [];
  const unverified = statements.filter((s) => s.status !== "verified").length;
  artifactTitle(
    card,
    "Dose check",
    data.all_verified ? "verified" : `${unverified} to review`,
  );

  const list = document.createElement("ul");
  list.className = "dose-check-list";
  for (const statement of statements) {
    const item = document.createElement("li");
    item.className = `dose-check-item status-${statement.status || "unverified"}`;

    const badge = document.createElement("span");
    badge.className = `badge severity-${statement.status || "unverified"}`;
    badge.textContent = statement.status || "unverified";
    item.appendChild(badge);

    const text = document.createElement("span");
    text.className = "dose-check-text";
    text.textContent = statement.text;
    item.appendChild(text);

    const reference = statement.reference;
    if (reference) {
      const refEl = document.createElement("div");
      refEl.className = "dose-check-ref";
      if (reference.citation_id) {
        // Links into the Sources bibliography rendered below the answer.
        const link = document.createElement("a");
        link.href = `#ref-${reference.citation_id}`;
        refEl.appendChild(link);
        const detail = document.createElement("span");
        detail.textContent = reference.excerpt || reference.context || "";
        refEl.appendChild(detail);
      } else {
        const label = [reference.title, reference.excerpt, reference.context]
          .filter(Boolean)
          .join(" — ");
        refEl.textContent = label || reference.source || "";
      }
      item.appendChild(refEl);
    }
    list.appendChild(item);
  }
  card.appendChild(list);
}

function renderPillImages(card, data) {
  const route = data.route ? ` (${data.route})` : "";
  artifactTitle(card, `Pill images — ${data.drug?.name || "unknown"}${route}`);
  const strip = document.createElement("div");
  strip.className = "pill-images";
  for (const url of data.images || []) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = `Pill image for ${data.drug?.name || "drug"}`;
    img.loading = "lazy";
    strip.appendChild(img);
  }
  card.appendChild(strip);
}

function renderArtifactSources(card, sources) {
  if (!Array.isArray(sources) || !sources.length) return;
  const el = document.createElement("div");
  el.className = "artifact-sources";
  el.textContent = sources
    .map((source) => `${source.section || "source"} (${source.citation_id})`)
    .join(" · ");
  card.appendChild(el);
}

// Minimal server-sent-events parser over a fetch ReadableStream (EventSource
// cannot POST, and we need the response of a POST). Handles "event:" and
// multi-line "data:" fields per the SSE spec.
function createSSEParser(onEvent) {
  let buffer = "";
  function processBlock(block) {
    let eventName = "message";
    const dataLines = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
    }
    if (dataLines.length) onEvent(eventName, dataLines.join("\n"));
  }
  return {
    feed(text) {
      buffer += text.replace(/\r\n/g, "\n");
      let separator;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        processBlock(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
      }
    },
    flush() {
      if (buffer.trim()) processBlock(buffer);
      buffer = "";
    },
  };
}

function scrollBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}
