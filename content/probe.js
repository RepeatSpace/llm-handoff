(function installEarlyProbe() {
  if (document.documentElement?.dataset?.llmHandoffEarlyProbe === "1") {
    return;
  }

  if (document.documentElement) {
    document.documentElement.dataset.llmHandoffEarlyProbe = "1";
  }

  const script = document.createElement("script");
  script.textContent = `(() => {
    if (window.__llmHandoffEarlyProbeInstalled) return;
    window.__llmHandoffEarlyProbeInstalled = true;
    const send = (type, payload) => window.postMessage({ source: "llm-handoff-page-probe", type, payload }, "*");
    const interesting = (value) => /conversation|backend-api|messages|chat|textdocs/i.test(String(value || ""));
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

    window.addEventListener("message", async (event) => {
      if (event.source !== window || event.data?.source !== REQUEST_TYPE) {
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

    try {
      const originalFetch = window.fetch;
      if (originalFetch) {
        window.fetch = async (...args) => {
          const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
          if (interesting(url)) send("fetch", { url: String(url || ""), at: Date.now(), phase: "early" });
          return originalFetch.apply(window, args);
        };
      }
    } catch (_error) {}

    try {
      const originalOpen = XMLHttpRequest.prototype.open;
      if (originalOpen) {
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          if (interesting(url)) send("xhr", { method: String(method || ""), url: String(url || ""), at: Date.now(), phase: "early" });
          return originalOpen.call(this, method, url, ...rest);
        };
      }
    } catch (_error) {}
  })();`;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
})();
