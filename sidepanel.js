(function () {
  "use strict";

  const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
  const HAS_URL_RE = /https?:\/\/[^\s<>"']+/;
  const MAX_DEBUG_LOGS = 20;

  const state = {
    split: "single",
    splitRatio: 50,
    activePane: 0,
    panes: [
      { locked: false, mode: "auto", text: "", source: "分栏 1", cellContext: null },
      { locked: false, mode: "auto", text: "", source: "分栏 2", cellContext: null }
    ],
    debug: {
      open: false,
      alert: false,
      logs: []
    }
  };

  const panesEl = document.querySelector(".fz-panes");
  const titleEl = document.querySelector(".fz-title");
  const toastEl = document.querySelector(".fz-toast");
  const splitterEl = document.querySelector(".fz-splitter");
  const debugSectionEl = document.querySelector(".fz-debug");
  const debugToggleEl = document.querySelector(".fz-debug-toggle");
  const debugAlertDotEl = document.querySelector(".fz-debug-alert-dot");
  const debugPanelEl = document.querySelector(".fz-debug-panel");
  const debugCountEl = document.querySelector(".fz-debug-count");
  const debugContentEl = document.querySelector(".fz-debug-content");

  document.addEventListener("click", (event) => {
    const paneEl = event.target.closest(".fz-pane");
    if (paneEl) {
      state.activePane = Number(paneEl.dataset.pane);
      renderChrome();
    }

    const modeBtn = event.target.closest("[data-mode]");
    if (modeBtn) {
      const modePaneEl = modeBtn.closest(".fz-pane");
      if (!modePaneEl) return;
      const paneIndex = Number(modePaneEl.dataset.pane);
      state.panes[paneIndex].mode = modeBtn.dataset.mode;
      renderAll();
      return;
    }

    const actionBtn = event.target.closest("[data-action]");
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;

    if (action === "lock") {
      const lockPaneEl = actionBtn.closest(".fz-pane");
      if (!lockPaneEl) return;
      const paneIndex = Number(lockPaneEl.dataset.pane);
      state.panes[paneIndex].locked = !state.panes[paneIndex].locked;
      renderAll();
      showToast(state.panes[paneIndex].locked ? "已锁定当前分栏" : "已解锁当前分栏");
      return;
    }

    if (action === "split-single") {
      state.split = "single";
      state.activePane = 0;
      renderAll();
      return;
    }

    if (action === "split-vertical") {
      state.split = "vertical";
      renderAll();
      return;
    }

    if (action === "split-horizontal") {
      state.split = "horizontal";
      renderAll();
      return;
    }

    if (action === "toggle-debug") {
      state.debug.open = !state.debug.open;
      if (state.debug.open) state.debug.alert = false;
      renderDebug();
      return;
    }

    if (action === "copy-debug") {
      copyLatestDebug();
      return;
    }

    if (action === "clear-debug") {
      state.debug.logs = [];
      state.debug.alert = false;
      renderDebug();
      showToast("已清空调试记录");
    }
  });

  splitterEl.addEventListener("pointerdown", startSplitResize);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;

    if (message.type === "FZ_CAPTURE_DEBUG") {
      pushDebugLog(message.debug || {});
      return;
    }

    if (message.type === "FZ_CAPTURE_EMPTY") {
      showToast(message.reason || "本次点击未读取到单元格内容。");
      return;
    }

    if (message.type === "FZ_CAPTURE_ERROR") {
      const errText = message.error && message.error.message ? message.error.message : "未知错误";
      showToast(`读取出错：${errText}`);
      return;
    }

    if (message.type === "FZ_CAPTURE_BLOCKED") {
      showToast("当前页面返回了权限提示文本，已忽略该结果。");
      return;
    }

    if (message.type !== "FZ_CELL_SELECTED") return;
    writeToActivePane(
      message.text || "",
      message.source || "点击的单元格",
      message.cellContext || null
    );
  });

  renderAll();

  function pushDebugLog(log) {
    const normalized = normalizeDebugLog(log);
    state.debug.logs.unshift(normalized);
    if (state.debug.logs.length > MAX_DEBUG_LOGS) {
      state.debug.logs.length = MAX_DEBUG_LOGS;
    }

    if (normalized.finalResult.status !== "success" && !state.debug.open) {
      state.debug.alert = true;
    }
    renderDebug();
  }

  function normalizeDebugLog(log) {
    const attempts = Array.isArray(log.attempts) ? log.attempts : [];
    return {
      sessionId: log.sessionId || "",
      url: log.url || "",
      clickTarget: log.clickTarget || {},
      startedAt: log.startedAt || "",
      endedAt: log.endedAt || "",
      durationMs: Number.isFinite(log.durationMs) ? log.durationMs : 0,
      writeRequest: log.writeRequest && typeof log.writeRequest === "object" ? log.writeRequest : null,
      attempts: attempts.map((item) => ({
        step: Number(item.step || 0),
        source: item.source || "",
        elapsedMs: Number(item.elapsedMs || 0),
        hit: Boolean(item.hit),
        reason: item.reason || "",
        candidateLength: Number(item.candidateLength || 0),
        candidateSample: item.candidateSample || "",
        details: item.details == null ? null : item.details
      })),
      finalResult: {
        status: log.finalResult && log.finalResult.status ? log.finalResult.status : "unknown",
        chosenSource: log.finalResult && log.finalResult.chosenSource ? log.finalResult.chosenSource : "",
        reason: log.finalResult && log.finalResult.reason ? log.finalResult.reason : ""
      },
      debugType: log.writeRequest ? "write" : "capture"
    };
  }

  function copyLatestDebug() {
    if (!state.debug.logs.length) {
      showToast("暂无可复制的调试信息");
      return;
    }

    const payload = JSON.stringify(state.debug.logs[0], null, 2);
    navigator.clipboard.writeText(payload).then(() => {
      showToast("已复制最新调试信息");
    }).catch(() => {
      showToast("复制失败，请检查浏览器剪贴板权限");
    });
  }

  function writeToActivePane(text, source, cellContext) {
    const paneIndex = getWritablePaneIndex();
    if (paneIndex === -1) {
      showToast("两个分栏都已锁定");
      return;
    }

    state.activePane = paneIndex;
    const pane = state.panes[paneIndex];
    pane.text = text;
    pane.source = source;
    pane.cellContext = cellContext || pane.cellContext;
    renderAll();
  }

  function getWritablePaneIndex() {
    if (state.split === "single") {
      return state.panes[0].locked ? -1 : 0;
    }
    if (!state.panes[state.activePane].locked) return state.activePane;
    const other = state.activePane === 0 ? 1 : 0;
    if (!state.panes[other].locked) return other;
    return -1;
  }

  function renderAll() {
    renderChrome();
    renderPane(0);
    renderPane(1);
    renderDebug();
  }

  function renderChrome() {
    panesEl.className = `fz-panes fz-${state.split === "single" ? "single" : `split-${state.split}`}`;
    titleEl.textContent = state.split === "single" ? "CellPeek" : `CellPeek - 分栏 ${state.activePane + 1}`;
    panesEl.style.setProperty("--split-a", `${state.splitRatio}fr`);
    panesEl.style.setProperty("--split-b", `${100 - state.splitRatio}fr`);

    document.querySelector('[data-action="split-single"]').classList.toggle("fz-active", state.split === "single");
    document.querySelector('[data-action="split-vertical"]').classList.toggle("fz-active", state.split === "vertical");
    document.querySelector('[data-action="split-horizontal"]').classList.toggle("fz-active", state.split === "horizontal");

    document.querySelectorAll(".fz-pane").forEach((paneEl) => {
      paneEl.classList.toggle("fz-pane-active", Number(paneEl.dataset.pane) === state.activePane);
    });
  }

  function renderPane(index) {
    const pane = state.panes[index];
    const paneEl = document.querySelector(`[data-pane="${index}"]`);
    const contentEl = paneEl.querySelector(".fz-content");
    const lockBtn = paneEl.querySelector('[data-action="lock"]');

    lockBtn.classList.toggle("fz-active", pane.locked);
    lockBtn.textContent = pane.locked ? "🔒" : "🔓";
    lockBtn.title = pane.locked ? "点击解锁" : "点击锁定";
    lockBtn.setAttribute("aria-label", lockBtn.title);

    paneEl.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.classList.toggle("fz-active", btn.dataset.mode === pane.mode);
    });

    if (!pane.text) {
      contentEl.innerHTML = '<div class="fz-empty">点击表格中的单元格以展示内容。</div>';
      return;
    }

    contentEl.innerHTML = renderContent(pane.text, pane.mode);
    contentEl.querySelectorAll("a").forEach((link) => {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
  }

  function renderDebug() {
    debugToggleEl.setAttribute("aria-expanded", state.debug.open ? "true" : "false");
    debugPanelEl.hidden = !state.debug.open;
    debugAlertDotEl.hidden = !state.debug.alert;
    debugSectionEl.classList.toggle("fz-debug-alert", state.debug.alert);
    debugCountEl.textContent = `最近 ${state.debug.logs.length} 条`;

    if (!state.debug.logs.length) {
      debugContentEl.textContent = "暂无调试记录";
      return;
    }

    debugContentEl.textContent = JSON.stringify(state.debug.logs[0], null, 2);
  }

  function startSplitResize(event) {
    if (state.split === "single") return;
    event.preventDefault();
    splitterEl.setPointerCapture(event.pointerId);

    function move(moveEvent) {
      const rect = panesEl.getBoundingClientRect();
      const rawRatio = state.split === "vertical"
        ? ((moveEvent.clientX - rect.left) / rect.width) * 100
        : ((moveEvent.clientY - rect.top) / rect.height) * 100;
      state.splitRatio = Math.max(15, Math.min(85, rawRatio));
      renderChrome();
    }

    function end(endEvent) {
      splitterEl.releasePointerCapture(endEvent.pointerId);
      splitterEl.removeEventListener("pointermove", move);
      splitterEl.removeEventListener("pointerup", end);
      splitterEl.removeEventListener("pointercancel", end);
    }

    splitterEl.addEventListener("pointermove", move);
    splitterEl.addEventListener("pointerup", end);
    splitterEl.addEventListener("pointercancel", end);
  }

  function renderContent(text, mode) {
    const kind = mode === "auto" ? detectContentKind(text) : mode;

    if (kind === "json") {
      const parsed = parseJson(text);
      const pretty = parsed.ok ? JSON.stringify(parsed.value, null, 2) : text;
      return `<pre class="fz-json">${linkify(escapeHtml(pretty))}</pre>`;
    }

    if (kind === "raw") {
      return `<pre class="fz-raw">${linkify(escapeHtml(text))}</pre>`;
    }

    return `<div class="fz-rendered">${renderMarkdown(text)}</div>`;
  }

  function detectContentKind(text) {
    const trimmed = text.trim();
    if (parseJson(trimmed).ok) return "json";
    if (/^#{1,6}\s/m.test(trimmed)) return "md";
    if (/```|^\s*[-*+]\s+|^\s*\d+\.\s+|\[.+\]\(.+\)/m.test(trimmed)) return "md";
    return HAS_URL_RE.test(trimmed) ? "raw" : "md";
  }

  function parseJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (_) {
      return { ok: false, value: null };
    }
  }

  function renderMarkdown(markdown) {
    const codeBlocks = [];
    const linkBlocks = [];
    let text = markdown.replace(/```([\s\S]*?)```/g, (_, code) => {
      const token = `\u0000CODE${codeBlocks.length}\u0000`;
      codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/^\w+\n/, ""))}</code></pre>`);
      return token;
    });

    text = escapeHtml(text);
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
      const token = `\u0000LINK${linkBlocks.length}\u0000`;
      linkBlocks.push(`<a href="${url}">${label}</a>`);
      return token;
    });

    text = renderTables(text);
    text = text
      .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
      .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
      .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
      .replace(/^>\s?(.+)$/gm, "<blockquote>$1</blockquote>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*(?!\s)(.+?)(?<!\s)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

    text = linkify(text);
    text = renderLists(text);
    text = text.split(/\n{2,}/).map((block) => {
      if (/^\s*<(h\d|ul|ol|pre|blockquote|table)/.test(block)) return block;
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    }).join("");

    codeBlocks.forEach((html, index) => {
      text = text.replace(`\u0000CODE${index}\u0000`, html);
    });
    linkBlocks.forEach((html, index) => {
      text = text.replace(`\u0000LINK${index}\u0000`, html);
    });
    return text;
  }

  function renderLists(text) {
    const lines = text.split("\n");
    const output = [];
    let listType = null;

    for (const line of lines) {
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
      const nextType = unordered ? "ul" : ordered ? "ol" : null;

      if (nextType && listType !== nextType) {
        if (listType) output.push(`</${listType}>`);
        output.push(`<${nextType}>`);
        listType = nextType;
      }

      if (nextType) {
        output.push(`<li>${unordered ? unordered[1] : ordered[1]}</li>`);
      } else {
        if (listType) {
          output.push(`</${listType}>`);
          listType = null;
        }
        output.push(line);
      }
    }

    if (listType) output.push(`</${listType}>`);
    return output.join("\n");
  }

  function renderTables(text) {
    const lines = text.split("\n");
    const output = [];
    let index = 0;

    while (index < lines.length) {
      if (index + 1 < lines.length && isTableRow(lines[index]) && isSeparatorRow(lines[index + 1])) {
        const headers = splitTableRow(lines[index]);
        index += 2;
        const rows = [];
        while (index < lines.length && isTableRow(lines[index])) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }

        output.push([
          "<table><thead><tr>",
          headers.map((cell) => `<th>${cell}</th>`).join(""),
          "</tr></thead><tbody>",
          rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join(""),
          "</tbody></table>"
        ].join(""));
      } else {
        output.push(lines[index]);
        index += 1;
      }
    }

    return output.join("\n");
  }

  function isTableRow(line) {
    return /^\s*\|.+\|\s*$/.test(line);
  }

  function isSeparatorRow(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  }

  function splitTableRow(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  }

  function linkify(html) {
    return html.replace(URL_RE, (url, offset) => {
      if (html.slice(Math.max(0, offset - 6), offset) === 'href="') return url;
      const cleanUrl = url.replace(/(&quot;|&#39;|&gt;|&lt;|[),.;])+$/, "");
      const tail = url.slice(cleanUrl.length);
      return `<a href="${cleanUrl}">${cleanUrl}</a>${tail}`;
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  let toastTimer = 0;
  function showToast(message) {
    window.clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.add("fz-show");
    toastTimer = window.setTimeout(() => toastEl.classList.remove("fz-show"), 1800);
  }
})();
