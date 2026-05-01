---
'@ifc-lite/mcp': minor
'@ifc-lite/cli': minor
---

Add `@ifc-lite/mcp` — Model Context Protocol server for ifc-lite, exposing
the BIM runtime to any MCP-aware LLM agent (Claude Desktop, Cursor,
ChatGPT, Goose, Windsurf, Zed, custom). v0.1 ships with stdio + Streamable
HTTP transports, scope-gated tool surface across discovery / query /
geometry / validation (IDS + audit) / mutation / BCF / bSDD / diff /
export / LCA, an `ifc-lite://` resource scheme, nine pre-baked prompt
templates, and an `ifc-lite mcp` CLI subcommand.
