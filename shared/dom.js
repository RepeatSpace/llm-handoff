(function initDom(global) {
function textContent(node) {
  return (node?.textContent || "").replace(/\u00a0/g, " ").trim();
}

function normalizeWhitespace(value) {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeMarkdownText(value) {
  return value.replace(/\\/g, "\\\\");
}

function renderListItem(element, depth = 0) {
  const marker = element.parentElement?.tagName === "OL" ? "1." : "-";
  const indent = "  ".repeat(depth);
  const contentParts = [];
  const nestedLists = [];

  Array.from(element.childNodes).forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test(child.tagName)) {
      nestedLists.push(child);
      return;
    }

    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent?.trim();
      if (text) {
        contentParts.push(escapeMarkdownText(text));
      }
      return;
    }

    if (child.nodeType === Node.ELEMENT_NODE) {
      const text = inlineMarkdown(child).trim();
      if (text) {
        contentParts.push(text);
      }
    }
  });

  const lines = [];
  const primaryContent = normalizeWhitespace(contentParts.join(" ")).replace(/\n/g, " ").trim();
  lines.push(`${indent}${marker} ${primaryContent || ""}`.trimEnd());

  nestedLists.forEach((list) => {
    Array.from(list.children).forEach((li) => {
      lines.push(renderListItem(li, depth + 1));
    });
  });

  return lines.filter(Boolean).join("\n");
}

function renderTable(table) {
  const allRows = Array.from(table.querySelectorAll("tr")).map((tr) =>
    Array.from(tr.children).map((cell) =>
      normalizeWhitespace(inlineMarkdown(cell).replace(/\|/g, "\\|").trim()).replace(/\n/g, "<br>")
    )
  );

  if (allRows.length === 0) {
    return "";
  }

  const headerSource =
    allRows.find((row) => row.length > 0 && row.some((cell) => cell.length > 0)) || [];
  if (headerSource.length === 0) {
    return "";
  }

  const width = Math.max(...allRows.map((row) => row.length), headerSource.length);
  const normalizeRow = (row) =>
    Array.from({ length: width }, (_value, index) => row[index] || "");

  const header = normalizeRow(headerSource);
  const divider = header.map(() => "---");
  const body = allRows
    .filter((row) => row !== headerSource)
    .map(normalizeRow)
    .filter((row) => row.some((cell) => cell.length > 0));
  const markdownRows = [
    `| ${header.join(" | ")} |`,
    `| ${divider.join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`)
  ];
  return markdownRows.join("\n");
}

function inlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeMarkdownText(node.textContent || "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const tag = node.tagName;
  const inner = Array.from(node.childNodes).map((child) => inlineMarkdown(child)).join("");

  switch (tag) {
    case "CODE":
      if (node.parentElement?.tagName === "PRE") {
        return inner;
      }
      return `\`${inner.trim()}\``;
    case "STRONG":
    case "B":
      return `**${inner.trim()}**`;
    case "EM":
    case "I":
      return `*${inner.trim()}*`;
    case "A": {
      const href = node.getAttribute("href") || "";
      return href ? `[${inner.trim() || href}](${href})` : inner;
    }
    case "BR":
      return "\n";
    case "SUP":
    case "SUB":
      return inner;
    case "IMG": {
      const alt = node.getAttribute("alt") || "image";
      const src = node.getAttribute("src") || "";
      return src ? `![${alt}](${src})` : `![${alt}]()`;
    }
    case "SPAN":
      return inner;
    default:
      return inner;
  }
}

function elementToMarkdown(root) {
  if (!root) {
    return "";
  }

  const blocks = [];
  Array.from(root.childNodes).forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        blocks.push(escapeMarkdownText(text));
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      blocks.push(`${"#".repeat(level)} ${inlineMarkdown(node).trim()}`);
      return;
    }

    if (tag === "P" || tag === "DIV") {
      if (node.querySelector("pre")) {
        Array.from(node.childNodes).forEach((child) => {
          if (child.nodeType === Node.ELEMENT_NODE) {
            const markdown = elementToMarkdown(child);
            if (markdown) {
              blocks.push(markdown);
            }
          } else if (child.nodeType === Node.TEXT_NODE) {
            const text = child.textContent?.trim();
            if (text) {
              blocks.push(escapeMarkdownText(text));
            }
          }
        });
        return;
      }

      const text = inlineMarkdown(node).trim();
      if (text) {
        blocks.push(text);
      }
      return;
    }

    if (tag === "PRE") {
      const codeNode = node.querySelector("code");
      const languageClass = codeNode?.className || "";
      const language = languageClass.match(/language-([\w-]+)/)?.[1] || "";
      const code = codeNode?.innerText || node.innerText || "";
      blocks.push(`\`\`\`${language}\n${code.trimEnd()}\n\`\`\``);
      return;
    }

    if (tag === "UL" || tag === "OL") {
      const items = Array.from(node.children)
        .map((li) => renderListItem(li, 0))
        .filter(Boolean)
        .join("\n");
      if (items) {
        blocks.push(items);
      }
      return;
    }

    if (tag === "TABLE") {
      const table = renderTable(node);
      if (table) {
        blocks.push(table);
      }
      return;
    }

    if (tag === "BLOCKQUOTE") {
      const quote = normalizeWhitespace(inlineMarkdown(node))
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      blocks.push(quote);
      return;
    }

    const fallback = inlineMarkdown(node).trim();
    if (fallback) {
      blocks.push(fallback);
    }
  });

  return normalizeWhitespace(blocks.join("\n\n"));
}

function sanitizeFileNamePart(value) {
  return value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/g, "");
}

function detectLanguage(value) {
  return /[ぁ-んァ-ン一-龯]/.test(value) ? "ja" : "en";
}

global.LLMHandoffDom = {
  detectLanguage,
  elementToMarkdown,
  normalizeWhitespace,
  sanitizeFileNamePart,
  textContent
};
})(globalThis);
