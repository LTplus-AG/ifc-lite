---
'@ifc-lite/viewer': minor
---

Add a per-model Load Report panel showing source/schema, load path, existing geometry diagnostics, and applicable approximation settings (#3927).

Each loaded model now has a compact report: the file's schema version, resolved load path (wasm/cache/server/point-cloud), tessellation tier and fast-mode setting, plus the load's CSG/opening diagnostics rendered as actionable text (dropped representation items, silent no-op cuts, CSG failures, oversized content-hash reference drops). A model whose diagnostics were never captured for its current load (a cache hit, the server render path, GLB, or IFCX) reads as "diagnostics unavailable", never as a false "clean" result; a model with nothing diagnostic-worthy shows a quiet "clean" line instead of a fabricated warning.

Diagnostic hosts that carry a captured bounding box are listed as affected entities and can be selected and framed in 3D from the panel; hosts and dropped-item categories that carry no entity identity in the diagnostics contract are summarized as counts only, never invented as a selectable entity. The report can be exported as JSON for reproduction. Reachable from the Analyze ribbon tab and the command palette ("Load Report").
