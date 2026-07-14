(function initChatGPTExtractor(global) {
const {
  ATTACHMENT_FILE,
  ATTACHMENT_IMAGE,
  BLOCK_MARKDOWN,
  BLOCK_TEXT,
  ROLE_ASSISTANT,
  ROLE_USER,
  SOURCE_CHATGPT
} = global.LLMHandoffTypes;
const { elementToMarkdown, textContent } = global.LLMHandoffDom;

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueTopLevelNodes(nodes) {
  return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
}

function extractTitle() {
  const candidates = [
    document.querySelector("main header h1"),
    document.querySelector("article h1"),
    document.querySelector("nav [data-testid='conversation-title']"),
    document.querySelector("main h1"),
    document.querySelector("header h1"),
    document.querySelector("title")
  ];

  for (const candidate of candidates) {
    const value = textContent(candidate);
    if (value) {
      return value.replace(/\s*\|\s*ChatGPT.*$/, "");
    }
  }

  return "ChatGPT Conversation";
}

function looksLikeConversationLeaf(value) {
  return value
    && typeof value === "object"
    && (
      (typeof value.id === "string" && typeof value.create_time !== "undefined")
      || typeof value.message_type === "string"
      || typeof value.recipient === "string"
      || typeof value.author_role === "string"
      || (typeof value.status === "string" && Array.isArray(value.children))
      || (value.author && typeof value.author.role === "string")
      || Array.isArray(value.parts)
      || Array.isArray(value.content?.parts)
      || (typeof value.text === "string" && typeof value.role === "string")
    );
}

function collectJsonCandidates() {
  const candidates = [];

  if (global.__NEXT_DATA__) {
    candidates.push({ source: "__NEXT_DATA__", value: global.__NEXT_DATA__ });
  }

  for (const key of Object.keys(global)) {
    if (!/^__/.test(key) && !/DATA|CACHE|STATE|BOOTSTRAP|APOLLO|NEXT/i.test(key)) {
      continue;
    }
    try {
      const value = global[key];
      if (value && typeof value === "object") {
        candidates.push({ source: `window.${key}`, value });
      }
    } catch (_error) {
      // ignore inaccessible globals
    }
  }

  document.querySelectorAll("script[type='application/json'], script#__NEXT_DATA__").forEach((script, index) => {
    const text = script.textContent?.trim();
    if (!text) {
      return;
    }
    try {
      candidates.push({ source: `script[${index}]`, value: JSON.parse(text) });
    } catch (_error) {
      // ignore parse failures
    }
  });

  document.querySelectorAll("script:not([src])").forEach((script, index) => {
    const text = script.textContent || "";
    if (!/conversation|message|mapping|create_time|author/i.test(text)) {
      return;
    }

    const snippets = text.match(/\{[\s\S]{200,}\}/g) || [];
    snippets.slice(0, 3).forEach((snippet, snippetIndex) => {
      try {
        candidates.push({ source: `inline-script[${index}:${snippetIndex}]`, value: JSON.parse(snippet) });
      } catch (_error) {
        // ignore non-json script bodies
      }
    });
  });

  return candidates;
}

function flattenMappingMessages(root) {
  const mapping = root?.mapping || root?.conversation?.mapping || root?.state?.mapping;
  if (!mapping || typeof mapping !== "object") {
    return [];
  }

  return Object.values(mapping)
    .map((entry) => entry?.message || entry)
    .filter(Boolean);
}

function findFirstObjectByKey(root, targetKey, limit = 3000) {
  const queue = [root];
  const seen = new WeakSet();
  let inspected = 0;

  while (queue.length > 0 && inspected < limit) {
    const current = queue.shift();
    inspected += 1;
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (!Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, targetKey)) {
      return current[targetKey];
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return null;
}

function linearizeMappingMessages(root) {
  const mapping = root?.mapping || root?.conversation?.mapping || root?.state?.mapping;
  const currentNode = root?.current_node || root?.conversation?.current_node || root?.state?.current_node;
  if (!mapping || typeof mapping !== "object") {
    return [];
  }

  if (currentNode && mapping[currentNode]) {
    const path = [];
    const seen = new Set();
    let cursor = currentNode;
    while (cursor && mapping[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      path.push(mapping[cursor]?.message || mapping[cursor]);
      cursor = mapping[cursor]?.parent || mapping[cursor]?.message?.parent || null;
    }
    return path.reverse().filter(Boolean);
  }

  return Object.values(mapping)
    .sort((a, b) => {
      const aTime = a?.message?.create_time || a?.create_time || 0;
      const bTime = b?.message?.create_time || b?.create_time || 0;
      return aTime - bTime;
    })
    .map((entry) => entry?.message || entry)
    .filter(Boolean);
}

function findFirstObjectWithKeys(root, requiredKeys, limit = 3000) {
  const queue = [root];
  const seen = new WeakSet();
  let inspected = 0;

  while (queue.length > 0 && inspected < limit) {
    const current = queue.shift();
    inspected += 1;
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (!Array.isArray(current) && requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(current, key))) {
      return current;
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return null;
}

function flattenArrayMessages(root) {
  const candidates = [
    root?.messages,
    root?.conversation?.messages,
    root?.state?.messages,
    root?.items,
    root?.nodes,
    root?.linear_conversation,
    root?.conversation?.linear_conversation,
    root?.data?.messages,
    root?.props?.messages
  ].filter(Array.isArray);

  for (const candidate of candidates) {
    const normalized = candidate
      .map((entry) => entry?.message || entry?.data || entry)
      .filter(Boolean);
    if (normalized.length >= 2) {
      return normalized;
    }
  }

  return [];
}

function extractMessagesFromConversationBody(body) {
  const payload = body?.body || body;
  const shapeSummary = body?.shapeSummary || null;
  const transportError = body?.error || null;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const conversationRoot = findFirstObjectWithKeys(payload, ["mapping", "current_node"]) || payload;
  const nestedMapping = conversationRoot?.mapping || findFirstObjectByKey(payload, "mapping");
  const nestedCurrentNode = conversationRoot?.current_node || findFirstObjectByKey(payload, "current_node");
  const candidateRoot = nestedMapping
    ? { ...conversationRoot, mapping: nestedMapping, current_node: nestedCurrentNode }
    : conversationRoot;
  const linearized = linearizeMappingMessages(candidateRoot);
  const mapped = flattenMappingMessages(candidateRoot);
  const arrayMessages = flattenArrayMessages(candidateRoot);
  const leaves =
    linearized.length > 0
      ? linearized
      : mapped.length > 0
      ? mapped
      : arrayMessages.length > 0
        ? arrayMessages
        : findConversationLeaves(candidateRoot, 20000);

  const messages = uniqueBy(
    leaves.map((leaf) => ({
      sourceId: leaf.id || leaf.message_id || null,
      role: roleFromLeaf(leaf),
      content: blocksFromLeaf(leaf),
      attachments: []
    })),
    (message) => message.sourceId || messageSignature(message)
  ).filter((message) => message.role && message.content.length > 0);

  if (messages.length < 2) {
    return null;
  }

  const urlConversationId = window.location.pathname.match(/\/c\/([^/?#]+)/)?.[1] || null;
  const payloadConversationId = payload.conversation_id || conversationRoot.conversation_id || null;

  return {
    source: SOURCE_CHATGPT,
    title: payload.title || extractTitle(),
    url: window.location.href,
    exportedAt: new Date().toISOString(),
    language: document.documentElement.lang || undefined,
    attachments: [],
    diagnostics: {
      extractor: SOURCE_CHATGPT,
      visible_message_nodes: messages.length,
      visible_message_count: messages.length,
      extracted_message_count: messages.length,
      history_expansion_attempts: 0,
      reached_top: true,
      warnings: [],
      data_source: body?.source || "page_api",
      mapping_count: nestedMapping && typeof nestedMapping === "object" ? Object.keys(nestedMapping).length : 0,
      current_node_present: Boolean(nestedCurrentNode),
      conversation_id_match: Boolean(
        urlConversationId
        && payloadConversationId
        && urlConversationId === payloadConversationId
      ),
      branch_strategy: nestedCurrentNode ? "current_node_parent_chain" : "mapping_time_order_fallback",
      shape_summary: shapeSummary,
      api_error: transportError
    },
    messages
  };
}

function findConversationLeaves(root, limit = 5000) {
  const queue = [root];
  const seen = new WeakSet();
  const leaves = [];
  let inspected = 0;

  while (queue.length > 0 && inspected < limit) {
    const current = queue.shift();
    inspected += 1;
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (looksLikeConversationLeaf(current)) {
      leaves.push(current);
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return leaves;
}

function blocksFromLeaf(leaf) {
  const parts = leaf.content?.parts || leaf.parts || [];
  const text = parts
    .flatMap((part) => {
      if (typeof part === "string") {
        return [part];
      }
      if (part && typeof part.text === "string") {
        return [part.text];
      }
      if (part && typeof part.content === "string") {
        return [part.content];
      }
      return [];
    })
    .join("\n\n")
    .trim();

  if (!text) {
    return [];
  }

  return [{ type: BLOCK_TEXT, value: text }];
}

function roleFromLeaf(leaf) {
  const role = leaf.author?.role || leaf.author_role || leaf.role || leaf.message_type;
  if (role === "user" || role === "human") {
    return ROLE_USER;
  }
  if (role === "assistant") {
    return ROLE_ASSISTANT;
  }
  return null;
}

function extractMessagesFromJsonCandidates() {
  const candidates = collectJsonCandidates();
  let best = null;

  for (const candidate of candidates) {
    const mapped = flattenMappingMessages(candidate.value);
    const arrayMessages = flattenArrayMessages(candidate.value);
    const leaves =
      mapped.length > 0
        ? mapped
        : arrayMessages.length > 0
          ? arrayMessages
          : findConversationLeaves(candidate.value, 12000);
    const messages = uniqueBy(
      leaves.map((leaf) => ({
        role: roleFromLeaf(leaf),
        content: blocksFromLeaf(leaf),
        attachments: []
      })),
      (message) => messageSignature(message)
    ).filter((message) => message.role && message.content.length > 0);

    if (messages.length < 2) {
      continue;
    }

    if (!best || messages.length > best.messages.length) {
      best = {
        source: SOURCE_CHATGPT,
        title: extractTitle(),
        url: window.location.href,
        exportedAt: new Date().toISOString(),
        language: document.documentElement.lang || undefined,
        attachments: [],
        diagnostics: {
          extractor: SOURCE_CHATGPT,
          visible_message_nodes: messages.length,
          visible_message_count: messages.length,
          extracted_message_count: messages.length,
          history_expansion_attempts: 0,
          reached_top: true,
          warnings: [],
          data_source: candidate.source,
          json_candidate_count: candidates.length
        },
        messages
      };
    }
  }

  return best;
}

function collectAttachments(messageNode) {
  const attachments = [];

  messageNode.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (!src) {
      return;
    }
    attachments.push({
      kind: ATTACHMENT_IMAGE,
      name: img.getAttribute("alt") || "",
      url: src
    });
  });

  messageNode.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href");
    if (!href || href.startsWith("#")) {
      return;
    }
    if (href.startsWith("blob:") || href.includes("/files/")) {
      attachments.push({
        kind: ATTACHMENT_FILE,
        name: textContent(link),
        url: href
      });
    }
  });

  return attachments;
}

function roleFromNode(node) {
  const explicitRole =
    node.getAttribute("data-message-author-role")
    || node.getAttribute("data-author-role")
    || node.dataset?.messageAuthorRole
    || node.dataset?.authorRole
    || node.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role")
    || node.querySelector("[data-author-role]")?.getAttribute("data-author-role");
  const authorLabel = textContent(node.querySelector("h5, h6, h4, [aria-label], [data-testid*='author']")).toLowerCase();

  if (explicitRole === "user" || authorLabel.includes("you")) {
    return ROLE_USER;
  }

  if (explicitRole === "assistant" || authorLabel.includes("chatgpt")) {
    return ROLE_ASSISTANT;
  }

  return ROLE_ASSISTANT;
}

function extractBody(node) {
  const candidates = [
    node.querySelector("[data-testid='message-content']"),
    node.querySelector("[data-testid*='message-content']"),
    node.querySelector("[data-message-content]"),
    node.querySelector(".markdown"),
    node.querySelector("[class*='markdown']"),
    node.querySelector("[class*='prose']"),
    node
  ];

  for (const candidate of candidates) {
    const markdown = elementToMarkdown(candidate);
    if (markdown) {
      return markdown;
    }
  }

  return "";
}

function findMessageNodes() {
  const selectorGroups = [
    [
      "[data-testid^='conversation-turn-']"
    ],
    [
      "[data-message-author-role]"
    ],
    [
      "[data-testid*='conversation-turn']"
    ],
    [
      "[data-author-role]"
    ],
    [
      "article [data-testid*='message']"
    ],
    [
      "main article"
    ]
  ];

  for (const selectors of selectorGroups) {
    const nodes = uniqueTopLevelNodes(
      selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    );
    if (nodes.length >= 2) {
      return nodes;
    }
  }

  return [];
}

function scoreTurnCandidate(node) {
  const body = extractBody(node);
  if (!body || body.length < 20) {
    return -1;
  }

  let score = Math.min(8, Math.floor(body.length / 120));
  if (node.querySelector("[data-message-author-role], [data-author-role]")) {
    score += 6;
  }
  if (node.querySelector("[aria-label*='Copy'], [aria-label*='Regenerate'], button")) {
    score += 2;
  }
  if (/article|section/i.test(node.tagName)) {
    score += 2;
  }
  if (node.children.length >= 2) {
    score += 1;
  }
  return score;
}

function siblingGroupScore(children) {
  const viable = children
    .map((node) => ({ node, score: scoreTurnCandidate(node), body: extractBody(node) }))
    .filter((item) => item.score >= 2 && item.body.length >= 20);

  if (viable.length < 2) {
    return null;
  }

  const totalBody = viable.reduce((sum, item) => sum + item.body.length, 0);
  const withRoleHints = viable.filter((item) =>
    item.node.querySelector("[data-message-author-role], [data-author-role], [aria-label], h4, h5, h6")
  ).length;

  return {
    nodes: viable.map((item) => item.node),
    score: viable.length * 1000 + totalBody + withRoleHints * 300
  };
}

function findTurnCandidatesByStructure() {
  const main = document.querySelector("main");
  if (!main) {
    return [];
  }

  const groupCandidates = Array.from(main.querySelectorAll("main, div, section, article"))
    .map((parent) => siblingGroupScore(Array.from(parent.children)))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (groupCandidates.length > 0) {
    return groupCandidates[0].nodes;
  }

  const fallbackCandidates = Array.from(main.querySelectorAll("article, section, div"))
    .map((node) => ({ node, score: scoreTurnCandidate(node) }))
    .filter((item) => item.score >= 4)
    .sort((a, b) => b.score - a.score);

  const topLevel = uniqueTopLevelNodes(fallbackCandidates.map((item) => item.node));
  return topLevel
    .map((node) => ({ node, score: scoreTurnCandidate(node) }))
    .filter((item) => item.score >= 4)
    .sort((a, b) => {
      if (a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      return 1;
    })
    .map((item) => item.node);
}

function findScrollableAncestors(node) {
  const ancestors = [];
  let current = node?.parentElement || null;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const scrollable =
      current.scrollHeight > current.clientHeight + 120
      && /(auto|scroll|overlay)/.test(style.overflowY || "");
    if (scrollable) {
      ancestors.push(current);
    }
    current = current.parentElement;
  }
  return ancestors;
}

function getPreferredScrollRoots() {
  const nodes = findMessageNodes().length > 0 ? findMessageNodes() : findTurnCandidatesByStructure();
  const roots = nodes.flatMap((node) => findScrollableAncestors(node));
  return Array.from(new Set(roots));
}

function extractSharedPageSnapshot() {
  const candidates = Array.from(document.querySelectorAll("main article, article")).filter((node) => {
    const body = extractBody(node);
    return body.length > 0;
  });

  if (candidates.length < 2) {
    return null;
  }

  const messages = candidates.map((node, index) => {
    const body = extractBody(node);
    const attachments = collectAttachments(node);
    const guessedRole = index % 2 === 0 ? ROLE_USER : ROLE_ASSISTANT;
    const role = roleFromNode(node);
    return {
      role: role === ROLE_ASSISTANT && guessedRole === ROLE_USER && !textContent(node.querySelector("h4, h5, h6, [aria-label]"))
        ? guessedRole
        : role,
      content: body ? [{ type: BLOCK_MARKDOWN, value: body }] : [],
      attachments
    };
  });

  return {
    source: SOURCE_CHATGPT,
    title: extractTitle(),
    url: window.location.href,
    exportedAt: new Date().toISOString(),
    language: document.documentElement.lang || undefined,
    attachments: messages.flatMap((message) => message.attachments),
    diagnostics: buildDiagnostics(candidates, messages),
    messages
  };
}

function extractStructuredFallbackSnapshot() {
  const candidates = findTurnCandidatesByStructure();
  if (candidates.length < 2) {
    return null;
  }

  const messages = candidates.map((node, index) => {
    const body = extractBody(node);
    const attachments = collectAttachments(node);
    const guessedRole = index % 2 === 0 ? ROLE_USER : ROLE_ASSISTANT;
    const role = roleFromNode(node);
    return {
      role: role === ROLE_ASSISTANT && !textContent(node.querySelector("h4, h5, h6, [aria-label]"))
        ? guessedRole
        : role,
      content: body ? [{ type: BLOCK_MARKDOWN, value: body }] : [],
      attachments
    };
  }).filter((message) => message.content.length > 0 || message.attachments.length > 0);

  if (messages.length < 2) {
    return null;
  }

  return {
    source: SOURCE_CHATGPT,
    title: extractTitle(),
    url: window.location.href,
    exportedAt: new Date().toISOString(),
    language: document.documentElement.lang || undefined,
    attachments: messages.flatMap((message) => message.attachments),
    diagnostics: buildDiagnostics(candidates, messages),
    messages
  };
}

function guessVisibleMessageCount(messageNodes) {
  return uniqueBy(
    messageNodes.map((node) => node.getAttribute("data-testid") || textContent(node).slice(0, 120)),
    (value) => value
  ).length;
}

function buildDiagnostics(messageNodes, messages) {
  const visibleCount = guessVisibleMessageCount(messageNodes);
  return {
    extractor: SOURCE_CHATGPT,
    visible_message_nodes: messageNodes.length,
    visible_message_count: visibleCount,
    extracted_message_count: messages.length,
    history_expansion_attempts: 0,
    reached_top: false,
    warnings: messages.length < visibleCount
      ? ["画面上のメッセージ数より抽出件数が少なく、一部欠落の可能性があります。"]
      : []
  };
}

function totalBodyLength(messages) {
  return messages.reduce(
    (sum, message) => sum + (message.content || []).reduce((inner, block) => inner + (block.value || "").length, 0),
    0
  );
}

function snapshotScore(snapshot) {
  return (snapshot.messages?.length || 0) * 1000000 + totalBodyLength(snapshot.messages || []);
}

function withStrategy(snapshot, strategy) {
  return {
    ...snapshot,
    diagnostics: {
      ...snapshot.diagnostics,
      strategy_comparison: snapshot.diagnostics?.strategy_comparison || [],
      selector_strategy: strategy
    }
  };
}

function attachSourceShape(snapshot, context = {}) {
  const preferredBody = context.pageConversationBody;
  const shapeSummary = preferredBody?.shapeSummary || null;
  const payload = preferredBody?.body || null;
  const nestedMapping = payload ? findFirstObjectByKey(payload, "mapping") : null;
  const nestedCurrentNode = payload ? findFirstObjectByKey(payload, "current_node") : null;

  return {
    ...snapshot,
    diagnostics: {
      ...snapshot.diagnostics,
      shape_summary: shapeSummary || snapshot.diagnostics?.shape_summary || null,
      mapping_count:
        snapshot.diagnostics?.mapping_count
        || (nestedMapping && typeof nestedMapping === "object" ? Object.keys(nestedMapping).length : 0),
      current_node_present:
        typeof snapshot.diagnostics?.current_node_present === "boolean"
          ? snapshot.diagnostics.current_node_present
          : Boolean(nestedCurrentNode),
      api_error: snapshot.diagnostics?.api_error || context.pageConversationBody?.error || null
    }
  };
}

function messageSignature(message) {
  const body = (message.content || []).map((block) => block.value || "").join("\n");
  const attachmentKeys = (message.attachments || [])
    .map((attachment) => `${attachment.kind}:${attachment.name || ""}:${attachment.url || ""}`)
    .join("|");
  return `${message.role}::${body.slice(0, 500)}::${attachmentKeys}`;
}

function extractChatGPTSnapshot(context = {}) {
  const pageBodySnapshot = extractMessagesFromConversationBody({
    ...(context.pageConversationBody || {}),
    source: "page_api"
  });
  if (pageBodySnapshot) {
    return attachSourceShape(withStrategy(pageBodySnapshot, "network"), context);
  }

  const jsonSnapshot = extractMessagesFromJsonCandidates();
  if (jsonSnapshot) {
    return withStrategy(jsonSnapshot, "json_state");
  }

  const strategySnapshots = [];

  const messageNodes = findMessageNodes();
  if (messageNodes.length > 0) {
    const messages = messageNodes
      .map((node) => {
        const body = extractBody(node);
        const attachments = collectAttachments(node);
        return {
          role: roleFromNode(node),
          content: body ? [{ type: BLOCK_MARKDOWN, value: body }] : [],
          attachments
        };
      })
      .filter((message) => message.content.length > 0 || message.attachments.length > 0);

    if (messages.length > 0) {
      strategySnapshots.push(withStrategy({
        source: SOURCE_CHATGPT,
        title: extractTitle(),
        url: window.location.href,
        exportedAt: new Date().toISOString(),
        language: document.documentElement.lang || undefined,
        attachments: messages.flatMap((message) => message.attachments),
        diagnostics: buildDiagnostics(messageNodes, messages),
        messages
      }, "selector_based"));
    }
  }

  const structuredFallback = extractStructuredFallbackSnapshot();
  if (structuredFallback) {
    strategySnapshots.push(withStrategy(structuredFallback, "structure_based"));
  }

  const sharedSnapshot = extractSharedPageSnapshot();
  if (sharedSnapshot) {
    strategySnapshots.push(withStrategy(sharedSnapshot, "shared_article_fallback"));
  }

  if (strategySnapshots.length === 0) {
    throw new Error("ChatGPT の会話メッセージを検出できませんでした。");
  }

  const bestSnapshot = strategySnapshots.sort((a, b) => snapshotScore(b) - snapshotScore(a))[0];
  const strategyComparison = strategySnapshots.map((snapshot) => ({
    strategy: snapshot.diagnostics?.selector_strategy || null,
    messages: snapshot.messages?.length || 0,
    body_length: totalBodyLength(snapshot.messages || [])
  }));

  if ((bestSnapshot.messages || []).length === 0) {
    throw new Error("ChatGPT のメッセージ本文を抽出できませんでした。DOM 構造が変更された可能性があります。");
  }

  return attachDebuggerShape({
    ...bestSnapshot,
    diagnostics: {
      ...bestSnapshot.diagnostics,
      strategy_comparison: strategyComparison
    }
  }, context);
}

function extractChatGPTConversation(expansion = {}) {
  const snapshot = extractChatGPTSnapshot();
  if (snapshot.diagnostics.warnings.length > 0 && snapshot.messages.length < 2) {
    throw new Error(snapshot.diagnostics.warnings.join(" "));
  }
  return {
    ...snapshot,
    diagnostics: {
      ...snapshot.diagnostics,
      history_expansion_attempts: expansion?.attempts || 0,
      reached_top: Boolean(expansion?.reachedTop),
      warnings: [
        ...(!expansion?.reachedTop ? ["先頭までスクロールできていない可能性があります。"] : []),
        ...(snapshot.messages.length < snapshot.diagnostics.visible_message_count
          ? ["画面上のメッセージ数より抽出件数が少なく、一部欠落の可能性があります。"]
          : [])
      ]
    }
  };
}

global.LLMHandoffChatGPT = {
  extractChatGPTConversation,
  extractChatGPTSnapshot,
  getPreferredScrollRoots,
  messageSignature
};
})(globalThis);
