---
"@ifc-lite/mcp": minor
"@ifc-lite/cli": minor
---

The MCP wire protocol now runs on the official TypeScript SDK (`@modelcontextprotocol/server` 2.x). Tools, scopes, read-only mode, validation and the error envelope are unchanged. Spec-driven differences: a cancelled request gets no response (over HTTP in JSON mode the POST answers -32800; an SSE stream just ends); a request before `initialize` answers -32600 (was -32002; a method the server does not offer still answers -32601); a missing resource answers -32602 with `data.uri` (was -32002, and `JsonRpcErrorCode.ResourceNotFound` is gone; `ServerNotInitialized` is now -32600); a request with missing or malformed params answers -32602 (was -32603); a request whose envelope breaks JSON-RPC (null or fractional id, array params, extra top-level members) answers -32600; requests still in flight when the connection closes answer -32603; members a content block does not define in the spec are dropped from tool results; a server detached and attached again starts a new connection (uninitialized, no subscriptions, no log level). Node 20 or newer is required, for `@ifc-lite/cli` too (it runs `ifc-lite mcp`).
