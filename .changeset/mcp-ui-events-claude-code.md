---
"@ifc-lite/mcp": minor
---

Send clicks on agent-pushed A2UI surfaces back to the agent. The bridge accepts bounded `ui-event` frames from the paired viewer tab, lists a `tab_ui_events` tool that drains them (optionally waiting for the next click), and with `--channel` pushes each one into a Claude Code session as a channel message.
