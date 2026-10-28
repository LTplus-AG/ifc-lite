---
'@ifc-lite/mcp': minor
'@ifc-lite/cli': patch
---

The stdio server no longer writes the geometry engine's `[IFC-LITE]` diagnostic lines to stdout, where they broke clients that parse the JSON-RPC stream strictly. `console.log`, `console.info` and `console.debug` are routed to stderr when the stdio transport owns the process stdout, and both `ifc-lite-mcp` and `ifc-lite mcp` do the same before they load models. The routing is exported as `routeConsoleToStderr`. HTTP transports are unchanged.
