---
"@ifc-lite/mcp": patch
---

Order requests only until the initialize response is written; keep later requests concurrent, preserve cancellation before dispatch, and detach immediately at stdin EOF.
