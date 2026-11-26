---
"@ifc-lite/mcp": minor
---

The MCP wire protocol now matches what the server does (#11535).

- `PROTOCOL_VERSION` is `2025-11-25`. `2025-11-05` was never an MCP revision and is no longer negotiated; such clients get `2025-11-25`.
- Prompt messages use only `user` and `assistant` roles.
- `logging/setLevel` works: server log lines at or above the level go to the client as `notifications/message`. Nothing is sent before a level is set.
- `notifications/resources/list_changed` is sent when the loaded models change (new optional `ModelRegistry.onChange`; registries without it are checked after each tool call), and `notifications/tools/list_changed` when `setScope` changes the visible tools.
- New `resources/templates/list`; the entity URI is listed there instead of as a resource with literal braces.
- `ResourceLink` is the spec `resource_link` content type. `EmbeddedResource` is unchanged.
- An unknown resource URI or prompt name answers JSON-RPC `-32602`, not `-32603`.
- Tool definitions carry scope at `_meta["ifc-lite/scope"]` instead of a top-level `scope` field. `ToolDefinition.scope` is gone.
- `export_pdf_report` and `gherkin_check` are removed. Both always failed.
- Tool error text now includes the hint, for clients that ignore `structuredContent`.
- `initialize` instructions describe the real workflows, and `ifc-lite://server/manifest` lists the tools this session may call.
