---
'@ifc-lite/mcp': minor
'@ifc-lite/cli': patch
---

Session-scoped layer workspaces and ownership checks (#1030): layer drafts are keyed by transport session id (private per Streamable HTTP session, disposed on session end; stdio keeps the local draft space) while published layers, refs, and reviews are process-shared so reviewers can act on them from their own sessions. `ToolContext` carries a `SessionIdentity`, drafts/reviews record their creating principal, mutating layer tools are owner-gated (reviews also visible to listed reviewers), and unknown-id error details only enumerate ids visible to the caller. `HttpTransport` enforces the same scope identity on DELETE/SSE-attach as on POST and rejects session factories that don't bind the provided session id; both in-repo factories (`@ifc-lite/mcp` CLI and `ifc-lite mcp`) bind it.
