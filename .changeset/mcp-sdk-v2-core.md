---
"@ifc-lite/mcp": minor
---

The MCP wire protocol now runs on the official TypeScript SDK (`@modelcontextprotocol/server` 2.x). Tools, scopes, read-only mode, validation and the error envelope are unchanged. Spec-driven differences: a cancelled request gets no response; a request before `initialize` answers -32600 (was -32002); a missing resource answers -32602 with `data.uri` (was -32002); a request with missing or malformed params answers -32602 (was -32603); a server detached and attached again starts a new connection (uninitialized, no subscriptions, no log level). Node 20 or newer is required.
