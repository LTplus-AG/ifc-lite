---
"@ifc-lite/collab": patch
---

Fix `applyIfcxOverlay` silently dropping a concurrent peer's deletion: cross-call overlay tombstones were stored as one JSON array under a single doc key, so two peers tombstoning different paths at the same time each overwrote the other's array and Yjs resolved the shared key last-write-wins, discarding one peer's deletion even though both peers converged. Tombstones now live one-per-path in a dedicated registry, so concurrent deletions of different paths no longer race; a doc written before this change is still honoured (its array is read, never written, going forward).
