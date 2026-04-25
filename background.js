let lastFeishuTabId = null;

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

  if (!tab.url || !/^https?:\/\//.test(tab.url)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"]
    });
  } catch (error) {
    console.warn("Inject content script failed:", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !sender || !sender.tab || typeof sender.tab.id !== "number") return;
  if (typeof message.type === "string" && message.type.startsWith("FZ_")) {
    lastFeishuTabId = sender.tab.id;
  }
});
