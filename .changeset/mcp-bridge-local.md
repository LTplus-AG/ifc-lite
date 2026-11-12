---
"@ifc-lite/mcp": minor
---

Add `ifc-lite-mcp --bridge`: a stdio MCP server that forwards tool calls over a loopback WebSocket (`127.0.0.1`, default port 21517, `--bridge-port` to change) to one paired ifc-lite browser tab, so a local agent can work on the model open there. It loads no model of its own and stops, freeing its port, when stdin ends, closes or errors, or on SIGINT/SIGTERM.

- Pairing uses a one-time code shown by the new always-listed `bridge_status` tool and on stderr, with the port and code in the link's URL fragment. Wrong codes are answered after a growing delay and never retire the code.
- The upgrade is refused unless the Origin is allowlisted (`https://ifclite.com`, the `--bridge-viewer-url` origin, and `--allow-origin`) and the Host is loopback. Plain `http:` origins are accepted only on loopback hosts unless `--insecure` is passed.
- Each tab tool carries a `readOnly` label. While the tab grants read-only access, or the bridge runs `--read-only`, tools the tab labels mutating are hidden and refused. The labels are the tab's claim, and the tab must enforce read-only itself. Tools are listed with MCP `annotations` (`readOnlyHint`, `destructiveHint`) and an optional `title`.
- Tab-supplied descriptors, schemas and results are bounded in size and depth (`BRIDGE_LIMITS`). Results may carry text and structured content only, and the agent is told that tab-supplied text is data, not instructions.
- The transport-neutral frame protocol is exported, browser-safe, as `@ifc-lite/mcp/bridge-protocol`.

Also:

- `MCPServer` takes an optional `instructions` string.
- `Tool` and `ToolDefinition` take optional `title` and `annotations` (new `ToolAnnotations` type).
- `ToolErrorCode` gains `VIEWER_NOT_CONNECTED` and `TIMEOUT`.
- Input validation now reads only own properties, so a schema property named `toString` or `constructor` is no longer confused with `Object.prototype`.
- Over stdio, a response that cannot be serialized now answers its request with a JSON-RPC error instead of being dropped.

The browser side ships separately.
