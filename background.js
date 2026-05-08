let lastFeishuTabId = null;
const lastFeishuTabIdByWindow = new Map();
const lastFeishuFrameIdByTab = new Map();
const cellFrameHintsByTab = new Map();
const AUTO_CAPTURE_DELAY_MS = 60;
const INJECT_DEBOUNCE_MS = 300;
const injectedAtByTab = new Map();

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  rememberFeishuTab(tab);
  notifyPanelScope(tab);

  if (chrome.sidePanel && chrome.sidePanel.open) {
    try {
      await chrome.sidePanel.open(getSidePanelOpenOptions(tab));
    } catch (error) {
      console.warn("Open side panel failed:", error);
    }
  }

  await ensureContentScript(tab.id, { force: true });

  requestCurrentCellCapture(tab.id);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!activeInfo || typeof activeInfo.tabId !== "number") return;
  if (typeof activeInfo.windowId === "number") {
    lastFeishuTabIdByWindow.set(activeInfo.windowId, activeInfo.tabId);
  }
  lastFeishuTabId = activeInfo.tabId;
  notifyPanelScope({
    id: activeInfo.tabId,
    windowId: activeInfo.windowId
  });
  ensureContentScript(activeInfo.tabId).then((ok) => {
    if (ok) requestCurrentCellCapture(activeInfo.tabId);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof tabId !== "number") return;
  if (!changeInfo || (!changeInfo.url && changeInfo.status !== "complete")) return;
  if (changeInfo.url) {
    lastFeishuFrameIdByTab.delete(tabId);
    cellFrameHintsByTab.delete(tabId);
  }
  chrome.tabs.get(tabId).then((tab) => {
    if (!tab || !tab.active) return null;
    rememberFeishuTab(tab);
    notifyPanelScope(tab);
    return tab;
  }).then((tab) => {
    if (!tab) return null;
    return ensureContentScript(tabId, { force: Boolean(changeInfo.url) }).then((ok) => {
      if (ok) requestCurrentCellCapture(tabId);
    });
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastFeishuFrameIdByTab.delete(tabId);
  cellFrameHintsByTab.delete(tabId);
  injectedAtByTab.delete(tabId);
  if (lastFeishuTabId === tabId) lastFeishuTabId = null;
  for (const [windowId, rememberedTabId] of lastFeishuTabIdByWindow.entries()) {
    if (rememberedTabId === tabId) lastFeishuTabIdByWindow.delete(windowId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;
  if (message.fzRouted) return;

  if (message.type === "FZ_WRITE_CELL") {
    forwardWriteCell(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, reason: error && error.message ? error.message : "WRITE_FORWARD_FAILED" });
    });
    return true;
  }

  if (message.type === "FZ_PANEL_READY") {
    const tabId = resolvePanelCaptureTabId(message);
    if (typeof tabId === "number") {
      notifyPanelScope({
        id: tabId,
        windowId: toFiniteNumber(message.windowId)
      });
      ensureContentScript(tabId).then((ok) => {
        if (ok) requestCurrentCellCapture(tabId);
      });
    }
    return;
  }

  if (!sender || !sender.tab || typeof sender.tab.id !== "number") return;
  if (message.type.startsWith("FZ_")) {
    rememberFeishuTab(sender.tab);
  }
  if (message.type === "FZ_CELL_SELECTED") {
    rememberCellFrame(sender.tab.id, sender.frameId, message);
  }
  if (isPanelRoutedMessage(message.type)) {
    relayToPanels(message, sender);
  }
});

async function forwardWriteCell(message) {
  const tabId = resolveWriteTabId(message);
  if (typeof tabId !== "number") return { ok: false, reason: "NO_FEISHU_TAB" };
  const injected = await ensureContentScript(tabId);
  if (!injected) return { ok: false, reason: "CONTENT_SCRIPT_NOT_READY" };
  const frameId = resolveWriteFrameId(tabId, message);
  const options = typeof frameId === "number" ? { frameId } : undefined;
  try {
    return await chrome.tabs.sendMessage(tabId, message, options);
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : "WRITE_MESSAGE_FAILED" };
  }
}

function rememberFeishuTab(tab) {
  if (!tab || typeof tab.id !== "number") return;
  lastFeishuTabId = tab.id;
  if (typeof tab.windowId === "number") {
    lastFeishuTabIdByWindow.set(tab.windowId, tab.id);
  }
}

function getSidePanelOpenOptions(tab) {
  return { tabId: tab.id };
}

function resolvePanelCaptureTabId(message) {
  const windowId = toFiniteNumber(message && message.windowId);
  if (typeof windowId === "number" && lastFeishuTabIdByWindow.has(windowId)) {
    return lastFeishuTabIdByWindow.get(windowId);
  }

  const directTabId = toFiniteNumber(message && message.tabId);
  if (typeof directTabId === "number") return directTabId;

  return lastFeishuTabId;
}

function resolveWriteTabId(message) {
  const directTabId = toFiniteNumber(message && message.tabId);
  if (typeof directTabId === "number") return directTabId;

  return resolvePanelCaptureTabId(message);
}

function isPanelRoutedMessage(type) {
  return type === "FZ_CELL_SELECTED" ||
    type === "FZ_CAPTURE_DEBUG" ||
    type === "FZ_CAPTURE_EMPTY" ||
    type === "FZ_CAPTURE_ERROR" ||
    type === "FZ_CAPTURE_BLOCKED";
}

function relayToPanels(message, sender) {
  const tab = sender && sender.tab ? sender.tab : null;
  if (!tab || typeof tab.id !== "number") return;
  const routed = {
    ...message,
    fzRouted: true,
    tabId: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : null,
    frameId: typeof sender.frameId === "number" ? sender.frameId : null
  };
  const result = chrome.runtime.sendMessage(routed);
  if (result && typeof result.catch === "function") result.catch(() => {});
}

function notifyPanelScope(tab) {
  if (!tab || typeof tab.id !== "number") return;
  const routed = {
    type: "FZ_PANEL_SCOPE_CHANGED",
    fzRouted: true,
    tabId: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : null
  };
  const result = chrome.runtime.sendMessage(routed);
  if (result && typeof result.catch === "function") result.catch(() => {});
}

function rememberCellFrame(tabId, frameId, message) {
  if (typeof tabId !== "number" || typeof frameId !== "number") return;
  const keys = buildFrameHintKeys(message);
  if (!keys.length) return;

  lastFeishuFrameIdByTab.set(tabId, frameId);

  const hints = getFrameHints(tabId);
  keys.forEach((key) => {
    hints.set(key, frameId);
  });
}

function resolveWriteFrameId(tabId, message) {
  if (message && typeof message.frameId === "number") return message.frameId;

  const hints = cellFrameHintsByTab.get(tabId);
  if (hints) {
    const keys = buildFrameHintKeys(message);
    for (const key of keys) {
      if (hints.has(key)) return hints.get(key);
    }
  }

  return lastFeishuFrameIdByTab.get(tabId);
}

function getFrameHints(tabId) {
  let hints = cellFrameHintsByTab.get(tabId);
  if (!hints) {
    hints = new Map();
    cellFrameHintsByTab.set(tabId, hints);
  }
  return hints;
}

function buildFrameHintKeys(message) {
  const keys = [];
  const address = normalizeCellAddress(message && message.cellAddress);
  if (address) keys.push(`address:${address}`);

  const context = normalizeCellContext(message && message.cellContext);
  if (context) keys.push(`point:${context.x},${context.y}`);

  return keys;
}

function normalizeCellAddress(value) {
  const text = String(value || "").trim().toUpperCase();
  const match = text.match(/^\$?([A-Z]{1,4})\$?(\d{1,7})$/);
  return match ? `${match[1]}${match[2]}` : "";
}

function normalizeCellContext(context) {
  if (!context || typeof context !== "object") return null;
  const x = Number(context.x);
  const y = Number(context.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function ensureContentScript(tabId, options = {}) {
  if (typeof tabId !== "number") return false;

  const now = Date.now();
  const lastInjectedAt = injectedAtByTab.get(tabId) || 0;
  if (!options.force && now - lastInjectedAt < INJECT_DEBOUNCE_MS) return true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
    injectedAtByTab.set(tabId, now);
    return true;
  } catch (error) {
    injectedAtByTab.delete(tabId);
    return false;
  }
}

function requestCurrentCellCapture(tabId) {
  if (typeof tabId !== "number") return;
  setTimeout(() => {
    const result = chrome.tabs.sendMessage(tabId, { type: "FZ_CAPTURE_CURRENT_CELL" });
    if (result && typeof result.catch === "function") result.catch(() => {});
  }, AUTO_CAPTURE_DELAY_MS);
}
