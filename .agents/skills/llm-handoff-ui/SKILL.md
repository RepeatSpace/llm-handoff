---
name: llm-handoff-ui
description: Review and improve the usability and visual design of the LLM Handoff Chrome extension popup and preview while preserving its plain HTML, CSS, and JavaScript architecture.
---

# LLM Handoff UI

## Product task

Optimize the shortest path:

1. Extract the current conversation.
2. Confirm extraction quality.
3. Choose all messages, a range, or messages since the previous export.
4. Add handoff instructions.
5. Download or copy Markdown.

## Principles

- Prefer clarity over feature density.
- Keep one visually dominant action: download Markdown.
- Use progressive disclosure for project metadata and history.
- Show warnings with a concrete next action.
- Separate extraction quality from the selected export range.
- Keep internal terms such as `current_node`, `mapping`, and `page_api` out of normal UI.
- Avoid decorative gradients, excessive cards, and dashboard styling.
- Keep the existing framework-free implementation unless replacement is justified.
- Maintain WCAG AA contrast, visible focus states, keyboard access, 200% zoom support, and a usable 320px popup.

## Screen hierarchy

Popup: product name, short privacy statement, primary extraction action, status.

Preview:

1. Conversation identity and extraction quality
2. Export range and size
3. Handoff instructions
4. Primary download and secondary copy actions
5. Markdown preview
6. Collapsed project metadata and history

## Workflow

1. Inspect current HTML, CSS, and event handling.
2. Identify information hierarchy and interaction problems before styling.
3. Inspect or capture the popup and preview in important states when possible.
4. Implement one coherent interaction model.
5. Verify empty, success, warning, incomplete, selected-range, and incremental states.
6. Run syntax checks and confirm every referenced element still exists.

## Definition of done

- A new user can export without reading the README.
- The primary action is identifiable within three seconds.
- Advanced controls do not obstruct the common path.
- Warning states explain what to do next.
- Keyboard focus is visible and text is not clipped at 200% zoom.
