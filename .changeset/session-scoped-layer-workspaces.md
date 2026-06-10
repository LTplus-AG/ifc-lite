---
'@ifc-lite/mcp': minor
---

Session-scoped layer workspaces and ownership checks (#1030): layer draft/review workspaces are keyed by transport session id (isolated per Streamable HTTP session, disposed on session end; stdio keeps the shared local workspace), `ToolContext` carries a `SessionIdentity`, drafts/reviews record their creating principal, mutating layer tools are owner-gated, and unknown-id error details only enumerate ids visible to the caller.
