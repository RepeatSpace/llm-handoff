(function initClaudeExtractor(global) {
const {
  ATTACHMENT_FILE,
  ATTACHMENT_IMAGE,
  BLOCK_MARKDOWN,
  ROLE_ASSISTANT,
  ROLE_USER,
  SOURCE_CLAUDE
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
    document.querySelector("[data-testid='chat-title']"),
    document.querySelector("main h1"),
    document.querySelector("title")
  ];

  for (const candidate of candidates) {
    const value = textContent(candidate);
    if (value) {
      return value.replace(/\s*\|\s*Claude.*$/, "");
    }
  }

  return "Claude Conversation";
}

function collectAttachments(messageNode) {
  const attachments = [];
  messageNode.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src) {
      attachments.push({
        kind: ATTACHMENT_IMAGE,
        name: img.getAttribute("alt") || "",
        url: src
      });
    }
  });
  messageNode.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href");
    if (href && (href.startsWith("blob:") || href.includes("file"))) {
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
  const label = [
    node.getAttribute("data-testid"),
    textContent(node.querySelector("[aria-label], h5, h6"))
  ]
    .join(" ")
    .toLowerCase();

  return label.includes("human") || label.includes("user") || label.includes("you")
    ? ROLE_USER
    : ROLE_ASSISTANT;
}

function extractBody(node) {
  const candidates = [
    node.querySelector("[data-testid='chat-message-content']"),
    node.querySelector(".font-claude-message"),
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
      "[data-testid='user-message']",
      "[data-testid='assistant-message']"
    ],
    [
      "div[data-testid*='message']"
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
  const nodes = findMessageNodes();
  const roots = nodes.flatMap((node) => findScrollableAncestors(node));
  return Array.from(new Set(roots));
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
    extractor: SOURCE_CLAUDE,
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

function messageSignature(message) {
  const body = (message.content || []).map((block) => block.value || "").join("\n");
  const attachmentKeys = (message.attachments || [])
    .map((attachment) => `${attachment.kind}:${attachment.name || ""}:${attachment.url || ""}`)
    .join("|");
  return `${message.role}::${body.slice(0, 500)}::${attachmentKeys}`;
}

function extractClaudeSnapshot() {
  const messageNodes = findMessageNodes();
  if (messageNodes.length === 0) {
    throw new Error("Claude の会話メッセージを検出できませんでした。");
  }

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

  const attachments = messages.flatMap((message) => message.attachments);
  const diagnostics = buildDiagnostics(messageNodes, messages);

  if (messages.length === 0) {
    throw new Error("Claude のメッセージ本文を抽出できませんでした。DOM 構造が変更された可能性があります。");
  }

  return {
    source: SOURCE_CLAUDE,
    title: extractTitle(),
    url: window.location.href,
    exportedAt: new Date().toISOString(),
    language: document.documentElement.lang || undefined,
    attachments,
    diagnostics,
    messages
  };
}

function extractClaudeConversation(expansion = {}) {
  const snapshot = extractClaudeSnapshot();
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

global.LLMHandoffClaude = {
  extractClaudeConversation,
  extractClaudeSnapshot,
  getPreferredScrollRoots,
  messageSignature
};
})(globalThis);
