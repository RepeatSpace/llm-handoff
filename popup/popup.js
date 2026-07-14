async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function extractConversation(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "LLM_HANDOFF_EXTRACT" });
}

async function cacheConversation(conversation) {
  return chrome.runtime.sendMessage({
    type: "LLM_HANDOFF_SET_CONVERSATION",
    conversation
  });
}

function formatExtractionError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/Receiving end does not exist/i.test(message)) {
    return "このページで拡張の読み込みが古くなっています。ChatGPT または Claude の会話ページを再読み込みしてから、もう一度実行してください。";
  }

  return message || "不明なエラーです。";
}

function isSupportedUrl(url) {
  return /^https:\/\/(chatgpt\.com|claude\.ai)\//.test(url || "");
}

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  status.textContent = message;
  status.style.color = isError ? "#b42318" : "#4b5563";
}

document.getElementById("extract-button").addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isSupportedUrl(tab.url)) {
      throw new Error("ChatGPT または Claude の会話ページで実行してください。");
    }

    setStatus("会話を取得しています…");
    const response = await extractConversation(tab.id);

    if (!response?.ok) {
      throw new Error(response?.error || "会話の取得に失敗しました。");
    }

    await cacheConversation(response.conversation);

    await chrome.tabs.create({ url: chrome.runtime.getURL("preview/preview.html") });
    window.close();
  } catch (error) {
    setStatus(formatExtractionError(error), true);
  }
});
