(function initMarkdown(global) {
const { detectLanguage, normalizeWhitespace, sanitizeFileNamePart } = global.LLMHandoffDom;

function yamlEscape(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/"/g, '\\"')}"`;
}

function conversationIdFromUrl(url) {
  const match = String(url || "").match(/\/(?:c|chat)\/([^/?#]+)/);
  return match?.[1] || "";
}

function buildFrontmatter(conversation) {
  const exportInfo = conversation.exportInfo || {
    mode: "full",
    totalMessages: conversation.messages.length,
    exportedMessages: conversation.messages.length,
    start: 1,
    end: conversation.messages.length
  };
  const project = conversation.project || {};
  const lines = [
    "---",
    `schema_version: "0.3"`,
    `export_id: ${yamlEscape(exportInfo.exportId || "")}`,
    `exported_at: ${yamlEscape(conversation.exportedAt)}`,
    "source:",
    `  service: ${yamlEscape(conversation.source)}`,
    `  conversation_id: ${yamlEscape(conversationIdFromUrl(conversation.url))}`,
    `  url: ${yamlEscape(conversation.url || "")}`,
    `  title: ${yamlEscape(conversation.title || "Untitled Conversation")}`,
    `  language: ${yamlEscape(conversation.language || detectLanguage(conversation.title || ""))}`,
    "classification:",
    `  project: ${yamlEscape(project.name || "")}`,
    `  type: ${yamlEscape(project.type || "")}`,
    ...(project.tags?.length
      ? ["  tags:", ...project.tags.map((tag) => `    - ${yamlEscape(tag)}`)]
      : ["  tags: []"]),
    "relation:",
    `  parent_export_id: ${yamlEscape(project.relation?.parentExportId || "")}`,
    `  parent_file: ${yamlEscape(project.relation?.parentFileName || "")}`,
    "extraction:",
    `  source: ${conversation.diagnostics?.data_source || conversation.extraction?.source || "unknown"}`,
    `  confidence: ${conversation.extraction?.confidence || "unknown"}`,
    `  total_messages: ${exportInfo.totalMessages}`,
    "export:",
    `  mode: ${exportInfo.mode}`,
    `  range_start: ${exportInfo.start}`,
    `  range_end: ${exportInfo.end}`,
    `  first_message_id: ${yamlEscape(exportInfo.firstMessageId || "")}`,
    `  last_message_id: ${yamlEscape(exportInfo.lastMessageId || "")}`,
    `  previous_export_id: ${yamlEscape(exportInfo.previousExportId || "")}`,
    `  previous_last_message_id: ${yamlEscape(exportInfo.previousMessageId || "")}`,
    `  context_messages: ${exportInfo.contextMessages || 0}`,
    `  exported_messages: ${exportInfo.exportedMessages}`,
    `  new_messages: ${exportInfo.newMessages ?? exportInfo.exportedMessages}`,
    `  omitted_messages: ${exportInfo.totalMessages - exportInfo.exportedMessages}`,
    "---"
  ];
  return lines.join("\n");
}

function renderMetadata(conversation) {
  const exportInfo = conversation.exportInfo || {
    totalMessages: conversation.messages.length,
    exportedMessages: conversation.messages.length
  };
  const lines = [
    "## Export Summary",
    "",
    `- Source: ${conversation.source}`,
    `- URL: ${conversation.url || ""}`,
    `- Project: ${conversation.project?.name || "Unclassified"}`,
    `- Export Mode: ${exportInfo.mode || "full"}`,
    `- Exported Messages: ${exportInfo.exportedMessages} of ${exportInfo.totalMessages}`,
    `- Extraction Confidence: ${conversation.extraction?.confidence || "unknown"}`
  ];

  if (conversation.attachments?.length) {
    lines.push(`- Attachment Count: ${conversation.attachments.length}`);
  }
  lines.push(`- Warnings: ${conversation.diagnostics?.warnings?.length || 0}`);

  return lines.join("\n");
}

function renderDiagnostics(conversation) {
  const diagnostics = conversation.diagnostics;
  if (!diagnostics) {
    return "";
  }

  const lines = [
    "<details>",
    "<summary>Extraction Diagnostics</summary>",
    "",
    `- Reached Top: ${diagnostics.reached_top ? "yes" : "no"}`,
    `- Visible Message Nodes: ${diagnostics.visible_message_nodes || 0}`,
    `- Visible Message Count: ${diagnostics.visible_message_count || 0}`,
    `- Data Source: ${diagnostics.data_source || "unknown"}`,
    `- Selector Strategy: ${diagnostics.selector_strategy || "-"}`,
    `- Stable Iterations: ${conversation.extraction?.stable_iterations || 0}`
  ];
  if (diagnostics.warnings?.length) {
    lines.push("", "Warnings:", ...diagnostics.warnings.map((warning) => `- ${warning}`));
  }
  lines.push("", "</details>");
  return lines.join("\n");
}

function renderContentBlocks(message) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const rendered = blocks
    .map((block) => {
      if (!block?.value) {
        return "";
      }
      return block.value;
    })
    .filter(Boolean)
    .join("\n\n");

  return rendered || message.text || "";
}

function renderAttachments(message) {
  if (!message.attachments?.length) {
    return "";
  }

  const lines = ["#### 添付情報", ""];
  message.attachments.forEach((attachment) => {
    const parts = [`- ${attachment.kind}`];
    if (attachment.name) {
      parts.push(`name: ${attachment.name}`);
    }
    if (attachment.url) {
      parts.push(`url: ${attachment.url}`);
    }
    lines.push(parts.join(" / "));
  });
  return lines.join("\n");
}

function renderMessage(message, showMessageNumbers) {
  const role = message.role === "user" ? "User" : "Assistant";
  const number = showMessageNumbers && message.originalIndex ? ` [${message.originalIndex}]` : "";
  const heading = `### ${role}${number}`;
  const body = renderContentBlocks(message);
  const sections = [heading, "", body || "_(empty)_"];

  const attachments = renderAttachments(message);
  if (attachments) {
    sections.push("", attachments);
  }

  return sections.join("\n");
}

function renderConversation(conversation) {
  const render = (messages) => messages
    .map((message) => renderMessage(message, conversation.exportInfo?.showMessageNumbers))
    .join("\n\n");
  const contextCount = conversation.exportInfo?.contextMessages || 0;
  if (conversation.exportInfo?.mode !== "incremental" || contextCount === 0) {
    return ["## Conversation", "", render(conversation.messages)].join("\n");
  }

  const context = conversation.messages.slice(0, contextCount);
  const newMessages = conversation.messages.slice(contextCount);
  return [
    "## Previous Context",
    "",
    render(context),
    "",
    "## New Messages",
    "",
    render(newMessages)
  ].join("\n");
}

function buildMarkdown(conversation) {
  const handoff = conversation.handoffInstructions?.trim()
    || "この会話を引き継ぐ際は、決定事項だけでなく検討過程と制約条件も確認してください。";

  const parts = [
    buildFrontmatter(conversation),
    `# ${conversation.title || "Untitled Conversation"}`,
    "",
    renderMetadata(conversation),
    "",
    "## Handoff Instructions",
    "",
    handoff,
    "",
    renderConversation(conversation),
    "",
    renderDiagnostics(conversation)
  ];

  return normalizeWhitespace(parts.join("\n"));
}

function buildDownloadFileName(conversation) {
  const exportDate = conversation.exportedAt.slice(0, 10);
  const title = sanitizeFileNamePart(conversation.title || "untitled");
  return `${exportDate}_${conversation.source}_${title || "untitled"}.md`;
}

global.LLMHandoffMarkdown = {
  buildDownloadFileName,
  buildMarkdown
};
})(globalThis);
