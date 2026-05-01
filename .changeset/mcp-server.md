---
'@ifc-lite/mcp': minor
'@ifc-lite/cli': minor
---

Add `@ifc-lite/mcp` — Model Context Protocol server for ifc-lite, exposing
the BIM runtime to any MCP-aware LLM agent (Claude Desktop, Cursor,
ChatGPT, Goose, Windsurf, Zed, custom). v0.1 ships with stdio + Streamable
HTTP transports, scope-gated tool surface across discovery / query /
geometry / validation (IDS + audit) / mutation / BCF / bSDD / diff /
export / viewer, an `ifc-lite://` resource scheme, eleven pre-baked
prompt templates, and an `ifc-lite mcp` CLI subcommand.

The 3D viewer is a first-class workflow:
  • `viewer_open` boots the WebGL viewer in-process and swaps streaming
    adapters into the headless backend so every `bim.viewer.*` /
    `bim.visibility.*` call drives the live scene.
  • `viewer_colorize`, `viewer_isolate`, `viewer_fly_to`,
    `viewer_color_by_property`, `viewer_set_section` make agent-driven
    visualization a single tool call.
  • User picks in the browser flow back to MCP via SSE and surface as
    `notifications/resources/updated` on `ifc-lite://viewer/selection`.
    `viewer_get_selection` reads the latest pick; `viewer_wait_for_selection`
    blocks until the next click.
  • `viewer_ask` emits agent-friendly wording so the agent can request
    user permission before opening a browser tab.
  • CLI flags `--viewer`, `--viewer-port`, and `--open` automate startup.
