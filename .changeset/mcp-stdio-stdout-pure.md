---
'@ifc-lite/mcp': patch
---

The stdio server no longer writes the geometry engine's `[IFC-LITE]` diagnostic lines to stdout, where they broke clients that parse the JSON-RPC stream strictly. `console.log`, `console.info` and `console.debug` are routed to stderr when the stdio transport owns the process stdout, and `ifc-lite-mcp` does the same before it loads models. HTTP transports are unchanged.
