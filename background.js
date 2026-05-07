let lastFeishuTabId = null;
const AUTO_CAPTURE_DELAY_MS = 60;
const INJECT_DEBOUNCE_MS = 300;
const injectedAtByTab = new Map();

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  lastFeishuTabId = tab.id;

  if (chrome.sidePanel && chrome.sidePanel.open) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (error) {
      console.warn("Open side panel failed:", error);
    }
  }

  await ensureContentScript(tab.id, { force: true });

  requestCurrentCellCapture(tab.id);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!activeInfo || typeof activeInfo.tabId !== "number") return;
  lastFeishuTabId = activeInfo.tabId;
  ensureContentScript(activeInfo.tabId).then((ok) => {
    if (ok) requestCurrentCellCapture(activeInfo.tabId);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof tabId !== "number") return;
  if (!changeInfo || (!changeInfo.url && changeInfo.status !== "complete")) return;
  lastFeishuTabId = tabId;
  ensureContentScript(tabId, { force: Boolean(changeInfo.url) }).then((ok) => {
    if (ok) requestCurrentCellCapture(tabId);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "FZ_WRITE_CELL") {
    forwardWriteCell(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, reason: error && error.message ? error.message : "WRITE_FORWARD_FAILED" });
    });
    return true;
  }

  if (message.type === "FZ_PANEL_READY") {
    if (typeof lastFeishuTabId === "number") {
      ensureContentScript(lastFeishuTabId).then((ok) => {
        if (ok) requestCurrentCellCapture(lastFeishuTabId);
      });
    }
    return;
  }

  if (!sender || !sender.tab || typeof sender.tab.id !== "number") return;
  if (message.type.startsWith("FZ_")) {
    lastFeishuTabId = sender.tab.id;
  }
});

async function forwardWriteCell(message) {
  if (typeof lastFeishuTabId !== "number") return { ok: false, reason: "NO_FEISHU_TAB" };
  const injected = await ensureContentScript(lastFeishuTabId);
  if (!injected) return { ok: false, reason: "CONTENT_SCRIPT_NOT_READY" };
  try {
    return await chrome.tabs.sendMessage(lastFeishuTabId, message);
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : "WRITE_MESSAGE_FAILED" };
  }
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
