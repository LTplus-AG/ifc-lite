---
"@ifc-lite/mutations": minor
"@ifc-lite/sdk": patch
"@ifc-lite/mcp": patch
---

Expose a monotonic live-overlay invalidation token and use it for native Room preparation and geometry caching. History-free canonical edits and Undo/Redo now invalidate stale native preparation and cached geometry without changing the recorded Undo history.
