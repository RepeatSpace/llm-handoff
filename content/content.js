(function initContent(global) {
const {
  CONFIDENCE_INCOMPLETE,
  CONFIDENCE_UNCERTAIN,
  CONFIDENCE_VERIFIED,
  SOURCE_CHATGPT
} = global.LLMHandoffTypes;
const pageProbeState = {
  fetches: [],
  xhrs: [],
  windowHints: [],
  apiResults: new Map(),
  apiReady: false
};

function rememberProbeEvent(bucket, payload, max = 30) {
  pageProbeState[bucket].push(payload);
  if (pageProbeState[bucket].length > max) {
    pageProbeState[bucket].shift();
  }
}

function installPageProbe() {
  if (document.getElementById("llm-handoff-page-probe")) {
    return;
  }

  window.addEventListener("message", (event) => {
    if (event.data?.source !== "llm-handoff-page-probe") {
      return;
    }

    if (event.data.type === "fetch") {
      rememberProbeEvent("fetches", event.data.payload);
    }
    if (event.data.type === "xhr") {
      rememberProbeEvent("xhrs", event.data.payload);
    }
    if (event.data.type === "window-hints") {
      pageProbeState.windowHints = event.data.payload || [];
    }
    if (event.data.type === "api-result" && event.data.payload?.requestId) {
      pageProbeState.apiResults.set(event.data.payload.requestId, event.data.payload);
    }
    if (event.data.type === "api-ready") {
      pageProbeState.apiReady = true;
    }
  });

  const script = document.createElement("script");
  script.id = "llm-handoff-page-probe";
  script.textContent = `(() => {
    const send = (type, payload) => window.postMessage({ source: "llm-handoff-page-probe", type, payload }, "*");
    const interesting = (value) => /conversation|backend-api|messages|chat|mapping/i.test(String(value || ""));
    const REQUEST_TYPE = "llm-handoff-page-request";

    const summarizeShape = (root) => {
      if (!root || typeof root !== "object") return null;
      const describe = (value) => Array.isArray(value) ? \`array(\${value.length})\` : value === null ? "null" : typeof value;
      const interestingKeys = ["mapping", "current_node", "message", "messages", "author", "content", "children", "parent", "parts"];
      const queue = [{ path: "$", value: root, depth: 0 }];
      const seen = new WeakSet();
      const topLevel = Object.entries(root).slice(0, 40).map(([key, value]) => \`\${key}:\${describe(value)}\`);
      const interestingPaths = [];
      let inspected = 0;

      while (queue.length > 0 && inspected < 1500) {
        const current = queue.shift();
        inspected += 1;
        if (!current?.value || typeof current.value !== "object") continue;
        if (seen.has(current.value)) continue;
        seen.add(current.value);

        if (Array.isArray(current.value)) {
          if (current.depth < 4) {
            current.value.slice(0, 5).forEach((item, index) => {
              queue.push({ path: \`\${current.path}[\${index}]\`, value: item, depth: current.depth + 1 });
            });
          }
          continue;
        }

        Object.keys(current.value).forEach((key) => {
          const child = current.value[key];
          const childPath = \`\${current.path}.\${key}\`;
          if (interestingKeys.some((pattern) => key.toLowerCase().includes(pattern))) {
            interestingPaths.push(\`\${childPath}:\${describe(child)}\`);
          }
          if (current.depth < 4 && child && typeof child === "object") {
            queue.push({ path: childPath, value: child, depth: current.depth + 1 });
          }
        });
      }

      return {
        inspected,
        topLevel,
        interestingPaths: interestingPaths.slice(0, 80)
      };
    };

    const fetchConversationBody = async (conversationId) => {
      const sessionResponse = await fetch("/api/auth/session", { credentials: "include" });
      if (!sessionResponse.ok) {
        throw new Error(\`Session request failed: \${sessionResponse.status}\`);
      }

      const session = await sessionResponse.json();
      const token = session?.accessToken;
      if (!token) {
        throw new Error("ChatGPT access token was not available.");
      }

      const response = await fetch(\`/backend-api/conversation/\${encodeURIComponent(conversationId)}\`, {
        credentials: "include",
        headers: {
          Accept: "application/json",
          Authorization: \`Bearer \${token}\`
        }
      });

      if (!response.ok) {
        throw new Error(\`Conversation request failed: \${response.status}\`);
      }

      return response.json();
    };

    if (!window.__llmHandoffApiListenerInstalled) {
      window.__llmHandoffApiListenerInstalled = true;
      send("api-ready", { at: Date.now() });
      window.addEventListener("message", async (event) => {
        if (event.data?.source !== REQUEST_TYPE) {
          return;
        }

        if (event.data?.type !== "fetch-conversation") {
          return;
        }

        const requestId = event.data.requestId;
        const conversationId = event.data.conversationId;

        try {
          const body = await fetchConversationBody(conversationId);
          send("api-result", {
            requestId,
            ok: true,
            body,
            shapeSummary: summarizeShape(body)
          });
        } catch (error) {
          send("api-result", {
            requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error || "conversation fetch failed")
          });
        }
      });
    }

    try {
      const originalFetch = window.fetch;
      if (originalFetch && !window.__llmHandoffFetchWrapped) {
        window.__llmHandoffFetchWrapped = true;
        window.fetch = async (...args) => {
          const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
          if (interesting(url)) send("fetch", { url: String(url || ""), at: Date.now() });
          return originalFetch.apply(window, args);
        };
      }
    } catch (_error) {}

    try {
      const originalOpen = XMLHttpRequest.prototype.open;
      if (originalOpen && !XMLHttpRequest.prototype.__llmHandoffOpenWrapped) {
        XMLHttpRequest.prototype.__llmHandoffOpenWrapped = true;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          if (interesting(url)) send("xhr", { method: String(method || ""), url: String(url || ""), at: Date.now() });
          return originalOpen.call(this, method, url, ...rest);
        };
      }
    } catch (_error) {}

    try {
      const hints = Object.keys(window)
        .filter((key) => /NEXT|CACHE|STATE|APOLLO|conversation|message/i.test(key))
        .slice(0, 50);
      send("window-hints", hints);
    } catch (_error) {}
  })();`;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

installPageProbe();

function describeNode(node) {
  if (!node) {
    return "none";
  }
  const id = node.id ? `#${node.id}` : "";
  const className = typeof node.className === "string"
    ? `.${node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".")}`
    : "";
  return `${node.tagName?.toLowerCase() || "node"}${id}${className}`;
}

function getScrollableRoots() {
  const candidates = [
    document.querySelector("main"),
    ...Array.from(document.querySelectorAll("main *")),
    document.scrollingElement,
    document.documentElement,
    document.body
  ].filter(Boolean);

  const unique = Array.from(new Set(candidates));
  const scored = unique
    .map((node) => ({
      node,
      label: describeNode(node),
      overflowY: window.getComputedStyle(node).overflowY,
      scrollHeight: node.scrollHeight || 0,
      clientHeight: node.clientHeight || 0
    }))
    .filter((item) =>
      item.scrollHeight > item.clientHeight + 200
      && /(auto|scroll|overlay)/.test(item.overflowY || "")
    )
    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
    .slice(0, 5);

  if (scored.length > 0) {
    return scored;
  }

  const fallback = document.scrollingElement || document.documentElement || document.body;
  return [{ node: fallback, label: describeNode(fallback), overflowY: "auto", scrollHeight: fallback?.scrollHeight || 0, clientHeight: fallback?.clientHeight || 0 }];
}

function getExtractorPreferredRoots(extractor) {
  if (!extractor?.getPreferredScrollRoots) {
    return [];
  }

  const nodes = extractor.getPreferredScrollRoots() || [];
  return nodes.map((node) => ({
    node,
    label: describeNode(node),
    overflowY: window.getComputedStyle(node).overflowY,
    scrollHeight: node.scrollHeight || 0,
    clientHeight: node.clientHeight || 0
  }));
}

function prioritizeRoots(roots, source) {
  if (source !== global.LLMHandoffTypes.SOURCE_CHATGPT) {
    return roots;
  }

  const score = (candidate) => {
    const label = candidate.label || "";
    let points = 0;
    if (label.includes("scrollbar-gutter")) {
      points += 5;
    }
    if (label.includes("no-scrollbar")) {
      points += 2;
    }
    points += Math.min(3, Math.floor((candidate.scrollHeight - candidate.clientHeight) / 1000));
    return points;
  };

  return [...roots].sort((a, b) => score(b) - score(a));
}

function scrollPosition(root) {
  if (!root) {
    return 0;
  }
  if (root === document.body || root === document.documentElement || root === document.scrollingElement) {
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }
  return root.scrollTop;
}

function setScrollPosition(root, value) {
  if (!root) {
    return;
  }
  if (root === document.body || root === document.documentElement || root === document.scrollingElement) {
    window.scrollTo(0, value);
    document.documentElement.scrollTop = value;
    document.body.scrollTop = value;
    return;
  }
  root.scrollTop = value;
}

function scrollExtent(root) {
  if (!root) {
    return 0;
  }
  return Math.max(0, (root.scrollHeight || 0) - (root.clientHeight || window.innerHeight || 0));
}

function mergeMessages(existingMessages, incomingMessages, signatureFn) {
  if (existingMessages.length === 0) {
    return [...incomingMessages];
  }

  const existingKeys = existingMessages.map(signatureFn);
  const incomingKeys = incomingMessages.map(signatureFn);
  let bestOverlap = 0;

  const maxOverlap = Math.min(existingKeys.length, incomingKeys.length);
  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    const incomingTail = incomingKeys.slice(-overlap).join("\u0000");
    const existingHead = existingKeys.slice(0, overlap).join("\u0000");
    if (incomingTail === existingHead) {
      bestOverlap = overlap;
      break;
    }
  }

  if (bestOverlap > 0) {
    return [...incomingMessages.slice(0, incomingMessages.length - bestOverlap), ...existingMessages];
  }

  const seen = new Set(existingKeys);
  const prepended = incomingMessages.filter((message) => {
    const key = signatureFn(message);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return [...prepended, ...existingMessages];
}

function mergeAttachments(messages) {
  const seen = new Set();
  return messages.flatMap((message) => message.attachments || []).filter((attachment) => {
    const key = `${attachment.kind}:${attachment.name || ""}:${attachment.url || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildMessageSnapshot(message, index, signatureFn) {
  const contentValues = (message.content || []).map((block) => block.value || "").join("\n\n");
  const normalized = contentValues.replace(/\s+/g, " ").trim();
  const attachments = (message.attachments || []).map((attachment) => attachment.name || attachment.url || "");
  const codeBlockCount = (contentValues.match(/```/g) || []).length / 2;
  return {
    signature: signatureFn(message),
    role: message.role,
    markdown: contentValues,
    domOrder: index,
    signature_parts: {
      head: normalized.slice(0, 200),
      tail: normalized.slice(-100),
      attachments,
      code_block_count: codeBlockCount
    }
  };
}

function buildSnapshots(messages, signatureFn) {
  return messages.map((message, index) => buildMessageSnapshot(message, index, signatureFn));
}

function confidenceFromDiagnostics(messages, diagnostics) {
  const warnings = diagnostics.warnings || [];
  const candidateResults = diagnostics.candidate_results || [];
  const allReachedTop = candidateResults.length > 0 && candidateResults.every((candidate) => candidate.reached_top);
  const noWarnings = warnings.length === 0;
  const stableEnough = (diagnostics.snapshot_count || 0) >= 3;
  const visibleCovered = messages.length >= (diagnostics.visible_message_count || 0);
  const trustedSource = ["page_api", "debugger_conversation_body", "shared_page"].includes(diagnostics.data_source);

  if (
    diagnostics.data_source === "page_api"
    && diagnostics.conversation_id_match
    && diagnostics.current_node_present
    && (diagnostics.mapping_count || 0) >= messages.length
    && noWarnings
  ) {
    return CONFIDENCE_VERIFIED;
  }

  if (trustedSource && noWarnings && visibleCovered && (diagnostics.reached_top || allReachedTop) && stableEnough) {
    return CONFIDENCE_VERIFIED;
  }

  if (messages.length === 0 || warnings.some((warning) => /欠落/.test(warning))) {
    return CONFIDENCE_INCOMPLETE;
  }

  return CONFIDENCE_UNCERTAIN;
}

function buildDiagnosticsFromSnapshots(source, snapshots, messages, expansion, rootLabel) {
  const latestDiagnostics = snapshots[snapshots.length - 1]?.diagnostics || {};
  const visibleCounts = snapshots.map((snapshot) => snapshot.diagnostics?.visible_message_count || 0);
  const maxVisibleCount = visibleCounts.length ? Math.max(...visibleCounts) : 0;
  const warnings = [];
  if (!expansion?.reachedTop) {
    warnings.push("先頭までスクロールできていない可能性があります。");
  }
  if (messages.length < maxVisibleCount) {
    warnings.push("画面上の最大メッセージ数より抽出件数が少なく、一部欠落の可能性があります。");
  }

  const stableIterations = snapshots.length >= 2
    ? snapshots.reduce((count, snapshot, index, array) => {
      if (index === 0) {
        return count;
      }
      return count + (snapshot.messages.length === array[index - 1].messages.length ? 1 : 0);
    }, 0)
    : 0;

  return {
    extractor: source,
    visible_message_nodes: latestDiagnostics.visible_message_nodes || 0,
    visible_message_count: maxVisibleCount,
    extracted_message_count: messages.length,
    snapshot_count: snapshots.length,
    scroll_root: rootLabel,
    selector_strategy: latestDiagnostics.selector_strategy || null,
    strategy_comparison: latestDiagnostics.strategy_comparison || [],
    data_source: latestDiagnostics.data_source || "dom",
    json_candidate_count: latestDiagnostics.json_candidate_count || 0,
    mapping_count: latestDiagnostics.mapping_count || 0,
    current_node_present: Boolean(latestDiagnostics.current_node_present),
    conversation_id_match: Boolean(latestDiagnostics.conversation_id_match),
    branch_strategy: latestDiagnostics.branch_strategy || null,
    shape_summary: latestDiagnostics.shape_summary || null,
    api_error: latestDiagnostics.api_error || null,
    page_api_ready: Boolean(pageProbeState.apiReady),
    network_probe: {
      fetches: pageProbeState.fetches.slice(-10),
      xhrs: pageProbeState.xhrs.slice(-10),
      window_hints: pageProbeState.windowHints.slice(0, 20),
      resource_matches: performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => /conversation|backend-api|messages|chat/i.test(name))
        .slice(-20)
    },
    candidate_results: expansion?.candidateResults || [],
    history_expansion_attempts: expansion?.attempts || 0,
    reached_top: Boolean(expansion?.reachedTop),
    stable_iterations: stableIterations,
    warnings
  };
}

function headSignature(messages, signatureFn) {
  const head = messages.slice(0, 3).map(signatureFn);
  return head.join("\u0001");
}

function getConversationIdFromLocation() {
  const match = window.location.pathname.match(/\/c\/([^/?#]+)/);
  return match?.[1] || null;
}

async function getPageConversationBody() {
  const conversationId = getConversationIdFromLocation();
  if (!conversationId) {
    return null;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "LLM_HANDOFF_FETCH_CHATGPT_CONVERSATION",
      conversationId
    });
    if (!response?.ok) {
      return {
        body: null,
        shapeSummary: null,
        error: response?.error || "conversation fetch failed"
      };
    }
    return {
      body: response.body || null,
      shapeSummary: response.shapeSummary || null,
      error: null
    };
  } catch (error) {
    return {
      body: null,
      shapeSummary: null,
      error: error instanceof Error ? error.message : "conversation fetch failed"
    };
  }
}

async function getDebuggerConversationBody() {
  const response = await chrome.runtime.sendMessage({ type: "LLM_HANDOFF_GET_DEBUGGER_CONVERSATION_BODY" });
  return {
    body: response?.body || null,
    shapeSummary: response?.shapeSummary || null
  };
}

async function collectFromRoot(root, rootLabel, extractor, source, context = {}) {
  const snapshots = [];
  let mergedMessages = [];
  let attempts = 0;
  let lastPosition = -1;
  let stablePasses = 0;
  let lastHeadSignature = "";
  let stagnantHeadPasses = 0;
  let lastMessageCount = 0;
  let stagnantCountPasses = 0;

  if (root) {
    setScrollPosition(root, scrollExtent(root));
    await delay(500);
  }

  for (let pass = 0; pass < 36; pass += 1) {
    attempts += 1;
    const snapshot = extractor.extractChatGPTSnapshot
      ? extractor.extractChatGPTSnapshot(context)
      : extractor.extractClaudeSnapshot();
    snapshots.push(snapshot);
    mergedMessages = mergeMessages(mergedMessages, snapshot.messages, extractor.messageSignature);
    const currentHeadSignature = headSignature(mergedMessages, extractor.messageSignature);
    if (currentHeadSignature === lastHeadSignature) {
      stagnantHeadPasses += 1;
    } else {
      stagnantHeadPasses = 0;
      lastHeadSignature = currentHeadSignature;
    }

    if (mergedMessages.length === lastMessageCount) {
      stagnantCountPasses += 1;
    } else {
      stagnantCountPasses = 0;
      lastMessageCount = mergedMessages.length;
    }

    if (!root) {
      break;
    }

    const currentPosition = scrollPosition(root);
    if (currentPosition <= 0) {
      break;
    }

    if (currentPosition === lastPosition) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
    }

    if (stablePasses >= 2) {
      break;
    }

    if (stagnantHeadPasses >= 4 && stagnantCountPasses >= 4) {
      break;
    }

    lastPosition = currentPosition;
    const step = Math.max((root.clientHeight || window.innerHeight || 800) * 0.35, 220);
    const nextPosition = Math.max(0, currentPosition - step);
    setScrollPosition(root, nextPosition);
    await delay(nextPosition === 0 ? 900 : 650);
  }

  if (mergedMessages.length === 0) {
    throw new Error("会話メッセージを抽出できませんでした。DOM 構造が変更された可能性があります。");
  }

  const latest = snapshots[snapshots.length - 1];
  const reachedTop = root ? scrollPosition(root) === 0 : true;
  const diagnostics = buildDiagnosticsFromSnapshots(source, snapshots, mergedMessages, {
    attempts,
    reachedTop,
    fullyObserved: false
  }, rootLabel);
  const extraction = {
    source: "dom_snapshots",
    confidence: confidenceFromDiagnostics(mergedMessages, diagnostics),
    message_count: mergedMessages.length,
    reached_top: diagnostics.reached_top,
    stable_iterations: diagnostics.stable_iterations,
    warnings: diagnostics.warnings
  };
  return {
    source,
    title: latest.title,
    url: latest.url,
    exportedAt: new Date().toISOString(),
    language: latest.language,
    attachments: mergeAttachments(mergedMessages),
    diagnostics,
    extraction,
    messageSnapshots: buildSnapshots(mergedMessages, extractor.messageSignature),
    messages: mergedMessages
  };
}

async function extractConversationBySnapshots(extractor, source) {
  const preferred = getExtractorPreferredRoots(extractor);
  const generic = getScrollableRoots();
  const roots = prioritizeRoots(Array.from(
    new Map([...preferred, ...generic].map((candidate) => [candidate.node, candidate])).values()
  ), source);
  let best = null;
  const candidateResults = [];
  const pageConversationBody = source === SOURCE_CHATGPT ? await getPageConversationBody() : null;
  const context = {
    pageConversationBody,
    debuggerConversationBody: source === SOURCE_CHATGPT ? await getDebuggerConversationBody() : null
  };

  if (source === SOURCE_CHATGPT && pageConversationBody?.body) {
    const apiSnapshot = extractor.extractChatGPTSnapshot(context);
    if (apiSnapshot?.diagnostics?.data_source === "page_api") {
      const diagnostics = {
        ...apiSnapshot.diagnostics,
        snapshot_count: 1,
        scroll_root: "not_required",
        reached_top: true,
        stable_iterations: 1,
        warnings: apiSnapshot.diagnostics.warnings || [],
        page_api_ready: true,
        candidate_results: []
      };
      return {
        ...apiSnapshot,
        exportedAt: new Date().toISOString(),
        attachments: mergeAttachments(apiSnapshot.messages),
        diagnostics,
        extraction: {
          source: "network",
          confidence: confidenceFromDiagnostics(apiSnapshot.messages, diagnostics),
          message_count: apiSnapshot.messages.length,
          reached_top: true,
          stable_iterations: 1,
          warnings: diagnostics.warnings
        },
        messageSnapshots: buildSnapshots(apiSnapshot.messages, extractor.messageSignature)
      };
    }
  }

  for (const candidate of roots) {
    const result = await collectFromRoot(candidate.node, candidate.label, extractor, source, context);
    candidateResults.push({
      root: candidate.label,
      strategy: result.diagnostics.selector_strategy || null,
      messages: result.messages.length,
      snapshots: result.diagnostics.snapshot_count,
      reached_top: result.diagnostics.reached_top
    });
    if (!best || result.messages.length > best.messages.length) {
      best = result;
    }
    if (result.diagnostics.reached_top && result.messages.length >= result.diagnostics.visible_message_count) {
      best = result;
      break;
    }
  }

  if (!best) {
    throw new Error("会話メッセージを抽出できませんでした。DOM 構造が変更された可能性があります。");
  }

  return {
    ...best,
    diagnostics: {
      ...best.diagnostics,
      candidate_results: candidateResults
    },
    extraction: {
      ...(best.extraction || {}),
      confidence: confidenceFromDiagnostics(best.messages, {
        ...best.diagnostics,
        candidate_results: candidateResults
      })
    }
  };
}

async function extractConversation() {
  const host = window.location.hostname;

  if (host === "chatgpt.com") {
    return extractConversationBySnapshots(global.LLMHandoffChatGPT, global.LLMHandoffTypes.SOURCE_CHATGPT);
  }

  if (host === "claude.ai") {
    return extractConversationBySnapshots(global.LLMHandoffClaude, global.LLMHandoffTypes.SOURCE_CLAUDE);
  }

  throw new Error("このサイトは未対応です。");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "LLM_HANDOFF_EXTRACT") {
    return false;
  }

  (async () => {
    try {
      const conversation = await extractConversation();
      sendResponse({ ok: true, conversation });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  })();

  return true;
});
})(globalThis);
