---
"@ifc-lite/collab": minor
---

`CollabSession.captureDocState()`: full-state fork point (`Y.encodeStateAsUpdate`) for whole-doc layer publishing via `publishLayer`, distinct from `captureBaseline()`'s state vector for the per-user `extractUserLayer` path. Backs the viewer's live-session draft publishing (#1717).
