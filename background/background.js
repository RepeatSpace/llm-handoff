let currentConversation = null;
let latestProbeResult = null;

const DEBUGGER_VERSION = "1.3";
const PROBE_TIMEOUT_MS = 8000;
const URL_PATTERNS = [
  /\/backend-api\/conversation\/[^/]+/i,
  /\/backend-api\/.*conversation/i,
  /\/conversation\/[^/]+\/textdocs/i
];

function matchesInterestingUrl(url) {
  return URL_PATTERNS.some((pattern) => pattern.test(url || ""));
}

function isJsonContentType(contentType) {
  return /application\/json|text\/json/i.test(contentType || "");
}

function describeValueShape(value) {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function summarizeConversationShape(root) {
  if (!root || typeof root !== "object") {
    return null;
  }

  const interestingPatterns = [
    "mapping",
    "current_node",
    "message",
    "messages",
    "author",
    "content",
    "children",
    "parent",
    "parts"
  ];
  const seen = new WeakSet();
  const queue = [{ path: "$", value: root, depth: 0 }];
  const topLevel = Object.entries(root)
    .slice(0, 40)
    .map(([key, value]) => `${key}:${describeValueShape(value)}`);
  const interestingPaths = [];
  const objectSummaries = [];
  let inspected = 0;

  while (queue.length > 0 && inspected < 1500) {
    const current = queue.shift();
    const { path, value, depth } = current;
    inspected += 1;

    if (!value || typeof value !== "object") {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      if (
        interestingPatterns.some((pattern) => path.toLowerCase().includes(pattern))
        || value.some((item) => item && typeof item === "object")
      ) {
        objectSummaries.push(`${path} => array(${value.length})`);
      }
      if (depth < 4) {
        value.slice(0, 5).forEach((item, index) => {
          queue.push({ path: `${path}[${index}]`, value: item, depth: depth + 1 });
        });
      }
      continue;
    }

    const keys = Object.keys(value);
    if (depth <= 3) {
      objectSummaries.push(`${path} => object(${keys.length}) [${keys.slice(0, 8).join(",")}]`);
    }

    for (const key of keys) {
      const child = value[key];
      const childPath = `${path}.${key}`;
      if (interestingPatterns.some((pattern) => key.toLowerCase().includes(pattern))) {
        interestingPaths.push(`${childPath}:${describeValueShape(child)}`);
      }
      if (depth < 4 && child && typeof child === "object") {
        queue.push({ path: childPath, value: child, depth: depth + 1 });
      }
    }
  }

  return {
    inspected,
    topLevel,
    interestingPaths: interestingPaths.slice(0, 80),
    objectSummaries: objectSummaries.slice(0, 80)
  };
}

async function runDebuggerProbe(tabId) {
  const target = { tabId };
  const events = [];
  const requestMap = new Map();

  const listener = async (source, method, params) => {
    if (source.tabId !== tabId) {
      return;
    }

    if (method === "Network.responseReceived") {
      const url = params.response?.url || "";
      if (!matchesInterestingUrl(url)) {
        return;
      }
      requestMap.set(params.requestId, {
        url,
        status: params.response?.status,
        contentType: params.response?.mimeType || params.response?.headers?.["content-type"] || "",
        encodedDataLength: params.response?.encodedDataLength || 0
      });
      return;
    }

    if (method === "Network.loadingFinished") {
      const request = requestMap.get(params.requestId);
      if (!request) {
        return;
      }

      let bodyInfo = { bodyLength: 0, topLevelKeys: [], jsonLike: false, bodyPreview: "", parsedBody: null };
      try {
        const response = await chrome.debugger.sendCommand(target, "Network.getResponseBody", {
          requestId: params.requestId
        });
        const body = response?.body || "";
        bodyInfo.bodyLength = body.length;
        bodyInfo.bodyPreview = body.slice(0, 500);
      if (isJsonContentType(request.contentType)) {
        try {
          const parsed = JSON.parse(body);
          bodyInfo.jsonLike = true;
          bodyInfo.topLevelKeys = parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 20) : [];
          bodyInfo.parsedBody = parsed;
          bodyInfo.shapeSummary = summarizeConversationShape(parsed);
        } catch (_error) {
          // ignore non-json body parse failures
        }
      }
      } catch (_error) {
        bodyInfo = { ...bodyInfo, error: "body_unavailable" };
      }

      events.push({
        ...request,
        ...bodyInfo
      });
      requestMap.delete(params.requestId);
    }
  };

  try {
    await chrome.debugger.attach(target, DEBUGGER_VERSION);
    chrome.debugger.onEvent.addListener(listener);
    await chrome.debugger.sendCommand(target, "Network.enable");
    await chrome.tabs.reload(tabId);
    await new Promise((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS));
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
    try {
      await chrome.debugger.detach(target);
    } catch (_error) {
      // ignore detach failures
    }
  }

  latestProbeResult = {
    capturedAt: new Date().toISOString(),
    tabId,
    events
  };

  return latestProbeResult;
}

async function fetchChatGptConversationInPage(tabId, conversationId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [conversationId],
    func: async (id) => {
      const sessionResponse = await fetch("/api/auth/session", {
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      if (!sessionResponse.ok) {
        throw new Error(`Session request failed: ${sessionResponse.status}`);
      }

      const session = await sessionResponse.json();
      if (!session?.accessToken) {
        throw new Error("ChatGPT access token was not available.");
      }

      const response = await fetch(
        `/backend-api/conversation/${encodeURIComponent(id)}`,
        {
          credentials: "include",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${session.accessToken}`
          }
        }
      );
      if (!response.ok) {
        throw new Error(`Conversation request failed: ${response.status}`);
      }

      return response.json();
    }
  });

  const body = results?.[0]?.result || null;
  if (!body || typeof body !== "object") {
    throw new Error("ChatGPT conversation API returned no JSON body.");
  }

  return {
    body,
    shapeSummary: summarizeConversationShape(body)
  };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    handoffTemplate:
      "この会話を引き継ぐ際は、決定事項だけでなく検討過程と制約条件も確認してください。"
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "LLM_HANDOFF_SET_CONVERSATION") {
    currentConversation = message.conversation || null;
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "LLM_HANDOFF_GET_CONVERSATION") {
    sendResponse({ ok: true, conversation: currentConversation });
    return false;
  }

  if (message?.type === "LLM_HANDOFF_RUN_DEBUGGER_PROBE") {
    runDebuggerProbe(message.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "debugger probe failed"
      }));
    return true;
  }

  if (message?.type === "LLM_HANDOFF_GET_DEBUGGER_PROBE") {
    sendResponse({ ok: true, result: latestProbeResult });
    return false;
  }

  if (message?.type === "LLM_HANDOFF_GET_DEBUGGER_CONVERSATION_BODY") {
    const conversationEvent = latestProbeResult?.events?.find((event) =>
      /\/backend-api\/conversation\/[^/]+$/i.test(event.url || "")
      && event.parsedBody
    ) || null;
    sendResponse({
      ok: true,
      body: conversationEvent?.parsedBody || null,
      shapeSummary: conversationEvent?.shapeSummary || null
    });
    return false;
  }

  if (message?.type === "LLM_HANDOFF_FETCH_CHATGPT_CONVERSATION") {
    const tabId = sender.tab?.id;
    if (!tabId || !message.conversationId) {
      sendResponse({ ok: false, error: "ChatGPT tab or conversation ID was unavailable." });
      return false;
    }

    fetchChatGptConversationInPage(tabId, message.conversationId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "ChatGPT conversation fetch failed."
      }));
    return true;
  }

  return false;
});
