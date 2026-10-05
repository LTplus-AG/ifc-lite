---
"@ifc-lite/mcp": patch
---

The MCP HTTP transport now bounds its session table. `initialize` was the only request that created a session and only `DELETE` removed one, so a client that never ended its sessions grew the table, and the server and layer workspace behind each entry, without limit. New `maxSessions` (default 1000) refuses further `initialize` calls with 503; at that cap, sessions with no request for `sessionIdleMs` (default 30 minutes) and no open SSE stream are reclaimed first, which disposes their unpublished layer drafts as `DELETE` does.
