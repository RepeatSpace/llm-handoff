let conversation = null;
let currentMarkdown = "";
let currentExportConversation = null;
let exportHistory = [];
let pendingExportId = crypto.randomUUID();
const { buildDownloadFileName, buildMarkdown } = globalThis.LLMHandoffMarkdown;
const { CONFIDENCE_INCOMPLETE, CONFIDENCE_UNCERTAIN } = globalThis.LLMHandoffTypes || {};
const HANDOFF_PRESETS = {
  continue: "この会話の決定事項、制約、未解決事項を確認し、現在の作業の続きから進めてください。\nすでに完了している作業を繰り返さないでください。",
  organize: "本文やコードを作り始める前に、この会話から決定事項、却下案、制約条件、未解決事項、次の作業を整理してください。",
  codex: "この会話は実装作業の引き継ぎ資料です。\nリポジトリの現状を確認し、この会話の仕様と照合してから作業してください。\n会話よりリポジトリの実装が新しい場合は、実装を優先してください。",
  "claude-code": "この会話の設計判断と制約を読み、既存コードを確認してから作業計画を作成してください。\n計画の承認前に広範囲な変更を行わないでください。"
};

async function getConversation() {
  const response = await chrome.runtime.sendMessage({ type: "LLM_HANDOFF_GET_CONVERSATION" });
  return response?.conversation || null;
}

function renderMetadata() {
  const meta = document.getElementById("conversation-meta");
  const items = [
    ["Title", conversation.title || ""],
    ["Source", conversation.source === "chatgpt" ? "ChatGPT" : "Claude"],
    ["Messages", String(conversation.messages?.length || 0)]
  ];

  meta.replaceChildren(
    ...items.flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    })
  );
}

function renderConfidence() {
  const node = document.getElementById("confidence");
  const confidence = conversation.extraction?.confidence || "unknown";
  const labels = {
    verified: "Verified",
    uncertain: "要確認",
    incomplete: "Incomplete",
    unknown: "Unknown"
  };
  node.textContent = labels[confidence] || labels.unknown;
  node.dataset.confidence = confidence;
}

function renderWarnings() {
  const container = document.getElementById("warnings");
  const warnings = conversation.diagnostics?.warnings || [];

  if (warnings.length === 0) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }

  container.hidden = false;
  container.replaceChildren(
    ...warnings.map((warning) => {
      const item = document.createElement("div");
      item.textContent = `- ${warning}`;
      return item;
    })
  );
}

function messageText(message) {
  return (message.content || []).map((block) => block.value || "").join("\n\n");
}

function parseTags(value) {
  return Array.from(new Set(
    String(value || "")
      .split(/[,\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
  ));
}

function projectMetadata() {
  return {
    name: document.getElementById("project-name").value.trim(),
    tags: parseTags(document.getElementById("project-tags").value),
    type: document.getElementById("conversation-type").value
  };
}

function normalizedRange() {
  const total = conversation.messages.length;
  const startInput = Number(document.getElementById("range-start").value) || 1;
  const endInput = Number(document.getElementById("range-end").value) || total;
  const start = Math.min(Math.max(startInput, 1), total);
  const end = Math.min(Math.max(endInput, start), total);
  return { start, end, total };
}

function selectedConversation() {
  const { start: selectedStart, end, total } = normalizedRange();
  const incremental = document.getElementById("incremental-mode").checked;
  const previous = incremental ? latestConversationExport() : null;
  const includeContext = incremental && document.getElementById("include-context").checked;
  const contextMessages = includeContext ? Math.min(2, selectedStart - 1) : 0;
  const start = selectedStart - contextMessages;
  const messages = conversation.messages.slice(start - 1, end).map((message, index) => ({
    ...message,
    originalIndex: start + index
  }));
  return {
    ...conversation,
    messages,
    attachments: messages.flatMap((message) => message.attachments || []),
    project: projectMetadata(),
    exportInfo: {
      exportId: pendingExportId,
      mode: incremental ? "incremental" : start === 1 && end === total ? "full" : "selected_range",
      totalMessages: total,
      exportedMessages: messages.length,
      omittedMessages: total - messages.length,
      start,
      end,
      selectedRangeStart: selectedStart,
      showMessageNumbers: true,
      firstMessageId: messages[0]?.sourceId || null,
      lastMessageId: messages[messages.length - 1]?.sourceId || null,
      previousExportId: previous?.exportId || null,
      previousMessageId: previous?.lastMessageId || null,
      contextMessages,
      newMessages: incremental ? end - selectedStart + 1 : messages.length
    }
  };
}

function latestConversationExport() {
  return exportHistory
    .filter((entry) => entry.sourceUrl === conversation.url && entry.lastMessageId)
    .sort((a, b) => String(b.exportedAt).localeCompare(String(a.exportedAt)))[0] || null;
}

function applyIncrementalMode() {
  const checkbox = document.getElementById("incremental-mode");
  const status = document.getElementById("incremental-status");
  if (!checkbox.checked) {
    status.hidden = true;
    status.classList.remove("error");
    document.getElementById("include-context").disabled = true;
    renderPreview();
    return;
  }

  const previous = latestConversationExport();
  if (!previous) {
    checkbox.checked = false;
    showIncrementalStatus("差分エクスポートを適用できませんでした。\n\nこの会話には、安定したメッセージIDを持つ前回履歴がありません。\n全文または手動範囲を選択してください。", true);
    return;
  }

  const previousIndex = conversation.messages.findIndex((message) => message.sourceId === previous.lastMessageId);
  if (previousIndex < 0) {
    checkbox.checked = false;
    showIncrementalStatus("差分エクスポートを適用できませんでした。\n\n前回の最終メッセージが現在の会話内に見つかりません。会話の編集、回答の再生成、分岐変更などが原因として考えられます。\n全文または手動範囲を選択してください。", true);
    return;
  }
  if (previousIndex >= conversation.messages.length - 1) {
    checkbox.checked = false;
    showIncrementalStatus("差分エクスポートを適用できませんでした。\n\n前回のダウンロード以降に新しいメッセージはありません。", true);
    return;
  }

  document.getElementById("include-context").disabled = false;
  document.getElementById("range-start").value = String(previousIndex + 2);
  document.getElementById("range-end").value = String(conversation.messages.length);
  const newCount = conversation.messages.length - previousIndex - 1;
  showIncrementalStatus(
    `差分エクスポート\n\n前回の末尾: ${new Date(previous.exportedAt).toLocaleString("ja-JP")}\n`
    + `Message: ${String(previous.lastMessageId).slice(0, 24)}\n今回追加: ${newCount} messages`,
    false
  );
  renderPreview();
}

function showIncrementalStatus(message, isError) {
  const status = document.getElementById("incremental-status");
  if (isError) {
    document.getElementById("include-context").disabled = true;
  }
  status.hidden = false;
  status.classList.toggle("error", isError);
  status.textContent = message;
}

function renderHistoryOptions() {
  const projectNames = Array.from(new Set(exportHistory.map((entry) => entry.project).filter(Boolean))).sort();
  document.getElementById("project-names").replaceChildren(...projectNames.map((name) => {
    const option = document.createElement("option");
    option.value = name;
    return option;
  }));

}

async function persistHistory() {
  exportHistory = exportHistory.slice(0, 500);
  await chrome.storage.local.set({ exportHistory });
  renderHistoryOptions();
  renderHistoryList();
}

function renderHistoryList() {
  document.getElementById("history-count").textContent = `保存件数: ${exportHistory.length} / 500`;
  const container = document.getElementById("history-list");
  container.replaceChildren(...exportHistory.map((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";
    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = `${String(entry.exportedAt).slice(0, 16).replace("T", " ")} · ${entry.fileName}`;

    const fields = document.createElement("div");
    fields.className = "history-fields";
    const projectInput = document.createElement("input");
    projectInput.value = entry.project || "";
    projectInput.placeholder = "プロジェクト";
    const typeSelect = document.createElement("select");
    [["", "未指定"], ["design", "設計"], ["implementation", "実装"], ["research", "調査"], ["brainstorming", "壁打ち"], ["minutes", "議事録"], ["other", "その他"]]
      .forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = entry.type === value;
        typeSelect.appendChild(option);
      });
    const tagsInput = document.createElement("input");
    tagsInput.value = (entry.tags || []).join(", ");
    tagsInput.placeholder = "タグ";
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "small-button danger-button";
    deleteButton.textContent = "削除";

    const update = async () => {
      entry.project = projectInput.value.trim();
      entry.type = typeSelect.value;
      entry.tags = parseTags(tagsInput.value);
      await persistHistory();
    };
    projectInput.addEventListener("change", update);
    typeSelect.addEventListener("change", update);
    tagsInput.addEventListener("change", update);
    deleteButton.addEventListener("click", async () => {
      if (!window.confirm("このエクスポート履歴を削除しますか。会話ファイル自体は削除されません。")) return;
      exportHistory = exportHistory.filter((candidate) => candidate.exportId !== entry.exportId);
      await persistHistory();
    });
    fields.append(projectInput, typeSelect, tagsInput, deleteButton);
    item.append(title, fields);
    return item;
  }));
}

function renderRangeSummary(selected) {
  const text = selected.messages.map(messageText).join("\n\n");
  const characters = text.length;
  const estimatedTokens = Math.ceil(characters / 2);
  const bytes = new Blob([currentMarkdown]).size;
  const info = selected.exportInfo;
  document.getElementById("range-summary").textContent =
    `選択範囲: ${info.exportedMessages} / ${info.totalMessages} messages · `
    + (info.mode === "incremental" ? `新規: ${info.newMessages} · 文脈: ${info.contextMessages} · ` : "")
    + `文字数: ${characters.toLocaleString()} · 推定トークン: 約${estimatedTokens.toLocaleString()} · `
    + `約${Math.ceil(bytes / 1024).toLocaleString()} KB`;
}

function renderMessageResults() {
  const query = document.getElementById("message-search").value.trim().toLowerCase();
  const userOnly = document.getElementById("user-only").checked;
  const container = document.getElementById("message-results");
  if (!query && !userOnly) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }

  const results = conversation.messages
    .map((message, index) => ({ message, number: index + 1, text: messageText(message) }))
    .filter(({ message, text }) => !userOnly || message.role === "user")
    .filter(({ text }) => !query || text.toLowerCase().includes(query))
    .slice(0, 100);

  container.hidden = false;
  container.replaceChildren(...results.map(({ message, number, text }) => {
    const row = document.createElement("div");
    row.className = "message-result";
    const summary = document.createElement("div");
    summary.className = "message-result-text";
    summary.textContent = `#${number} ${message.role === "user" ? "User" : "Assistant"}: ${text.replace(/\s+/g, " ").slice(0, 140)}`;
    const startButton = document.createElement("button");
    startButton.type = "button";
    startButton.textContent = "開始";
    startButton.addEventListener("click", () => setRangeBoundary("start", number));
    const endButton = document.createElement("button");
    endButton.type = "button";
    endButton.textContent = "終了";
    endButton.addEventListener("click", () => setRangeBoundary("end", number));
    row.append(summary, startButton, endButton);
    return row;
  }));
}

function setRangeBoundary(boundary, number) {
  document.getElementById("incremental-mode").checked = false;
  document.getElementById("incremental-status").hidden = true;
  document.getElementById("include-context").disabled = true;
  document.getElementById(`range-${boundary}`).value = String(number);
  renderPreview();
}

function renderPreview() {
  const handoffInstructions = document.getElementById("handoff-input").value.trim();
  const selected = selectedConversation();
  document.getElementById("range-start").value = String(selected.exportInfo.selectedRangeStart);
  document.getElementById("range-end").value = String(selected.exportInfo.end);
  const mergedConversation = {
    ...selected,
    handoffInstructions
  };

  currentExportConversation = mergedConversation;
  currentMarkdown = buildMarkdown(mergedConversation);
  document.getElementById("preview-output").textContent = currentMarkdown;
  renderRangeSummary(selected);
}

function showPreviewView(view) {
  const output = document.getElementById("preview-output");
  const help = document.getElementById("help-view");
  const showingHelp = view === "help";

  help.hidden = !showingHelp;
  output.hidden = showingHelp;
  document.getElementById("preview-tab").setAttribute("aria-selected", String(!showingHelp));
  document.getElementById("help-tab").setAttribute("aria-selected", String(showingHelp));
  document.getElementById("preview-note").textContent = showingHelp ? "基本操作と出力方法" : "編集内容は左側へ反映されます";
}

async function copyMarkdown() {
  renderPreview();

  const button = document.getElementById("copy-button");
  const status = document.getElementById("copy-status");
  const originalLabel = button.textContent;

  try {
    await navigator.clipboard.writeText(currentMarkdown);
    button.textContent = "コピーしました";
    status.textContent = "Markdown全文をクリップボードへコピーしました。";
  } catch (_error) {
    button.textContent = "コピーできませんでした";
    status.textContent = "クリップボードへのコピーに失敗しました。";
  } finally {
    window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 2000);
  }
}

async function downloadMarkdown() {
  renderPreview();
  const confidence = conversation.extraction?.confidence;
  if (confidence === CONFIDENCE_INCOMPLETE) {
    window.alert("この会話は Incomplete 判定です。欠落の可能性が高いため、既定では保存できません。");
    return;
  }

  if (confidence === CONFIDENCE_UNCERTAIN) {
    const shouldContinue = window.confirm("この会話は Uncertain 判定です。欠落の可能性があります。保存しますか。");
    if (!shouldContinue) {
      return;
    }
  }

  const filename = buildDownloadFileName(currentExportConversation);
  const blob = new Blob([currentMarkdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: true
    });
    const historyEntry = {
      exportId: currentExportConversation.exportInfo.exportId,
      exportedAt: new Date().toISOString(),
      source: currentExportConversation.source,
      sourceUrl: currentExportConversation.url,
      title: currentExportConversation.title,
      project: currentExportConversation.project?.name || "",
      tags: currentExportConversation.project?.tags || [],
      type: currentExportConversation.project?.type || "",
      fileName: filename,
      rangeStart: currentExportConversation.exportInfo.start,
      rangeEnd: currentExportConversation.exportInfo.end,
      firstMessageId: currentExportConversation.exportInfo.firstMessageId,
      lastMessageId: currentExportConversation.exportInfo.lastMessageId
    };
    exportHistory = [historyEntry, ...exportHistory.filter((entry) => entry.exportId !== historyEntry.exportId)].slice(0, 500);
    await chrome.storage.local.set({ exportHistory });
    pendingExportId = crypto.randomUUID();
    renderHistoryOptions();
    renderHistoryList();
    renderPreview();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function initialize() {
  const stored = await chrome.storage.local.get(["handoffTemplate", "exportHistory"]);
  exportHistory = Array.isArray(stored.exportHistory) ? stored.exportHistory : [];
  conversation = await getConversation();

  if (!conversation) {
    document.getElementById("preview-output").textContent =
      "保存対象の会話がありません。ChatGPT または Claude で拡張を実行してください。";
    return;
  }

  document.getElementById("handoff-input").value =
    conversation.handoffInstructions || stored.handoffTemplate || "";
  document.getElementById("range-start").value = "1";
  document.getElementById("range-end").value = String(conversation.messages.length);
  document.getElementById("range-start").max = String(conversation.messages.length);
  document.getElementById("range-end").max = String(conversation.messages.length);
  renderHistoryOptions();
  renderHistoryList();

  renderWarnings();
  renderMetadata();
  renderConfidence();
  renderMessageResults();
  renderPreview();
}

document.getElementById("copy-button").addEventListener("click", copyMarkdown);
document.getElementById("download-button").addEventListener("click", downloadMarkdown);
document.getElementById("preview-tab").addEventListener("click", () => showPreviewView("preview"));
document.getElementById("help-tab").addEventListener("click", () => showPreviewView("help"));
document.getElementById("handoff-input").addEventListener("input", renderPreview);
document.getElementById("handoff-preset").addEventListener("change", (event) => {
  const preset = HANDOFF_PRESETS[event.target.value];
  if (preset) {
    document.getElementById("handoff-input").value = preset;
    renderPreview();
  }
});
document.getElementById("range-start").addEventListener("change", () => {
  document.getElementById("incremental-mode").checked = false;
  document.getElementById("incremental-status").hidden = true;
  document.getElementById("include-context").disabled = true;
  renderPreview();
});
document.getElementById("range-end").addEventListener("change", () => {
  document.getElementById("incremental-mode").checked = false;
  document.getElementById("incremental-status").hidden = true;
  document.getElementById("include-context").disabled = true;
  renderPreview();
});
document.getElementById("message-search").addEventListener("input", renderMessageResults);
document.getElementById("user-only").addEventListener("change", renderMessageResults);
document.getElementById("reset-range-button").addEventListener("click", () => {
  document.getElementById("incremental-mode").checked = false;
  document.getElementById("incremental-status").hidden = true;
  document.getElementById("include-context").disabled = true;
  document.getElementById("range-start").value = "1";
  document.getElementById("range-end").value = String(conversation.messages.length);
  renderPreview();
});
document.getElementById("incremental-mode").addEventListener("change", applyIncrementalMode);
document.getElementById("include-context").addEventListener("change", renderPreview);
[
  "project-name",
  "project-tags",
  "conversation-type"
].forEach((id) => document.getElementById(id).addEventListener("change", renderPreview));
document.getElementById("project-name").addEventListener("input", () => {
  renderHistoryOptions();
  renderPreview();
});
document.getElementById("clear-history-button").addEventListener("click", async () => {
  if (!exportHistory.length || !window.confirm("すべてのエクスポート履歴を消去しますか。ダウンロード済みファイルは削除されません。")) return;
  exportHistory = [];
  await persistHistory();
});

initialize();
