(function initTypes(global) {
  global.LLMHandoffTypes = {
    SOURCE_CHATGPT: "chatgpt",
    SOURCE_CLAUDE: "claude",
    ROLE_USER: "user",
    ROLE_ASSISTANT: "assistant",
    ROLE_SYSTEM: "system",
    BLOCK_MARKDOWN: "markdown",
    BLOCK_TEXT: "text",
    ATTACHMENT_IMAGE: "image",
    ATTACHMENT_FILE: "file",
    CONFIDENCE_VERIFIED: "verified",
    CONFIDENCE_UNCERTAIN: "uncertain",
    CONFIDENCE_INCOMPLETE: "incomplete"
  };
})(globalThis);
