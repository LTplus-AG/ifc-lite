---
"@ifc-lite/create": patch
---

Rebind relative top constraints when their storey is deleted, preserving the floor offset. Refit slab-bound column, beam and member tops during direct moves and viewer gizmo edits.

Keep direct-move results consistent with the fitted placement, refuse unreadable floor targets and invalid deletion destinations, and refit copied walls to footprint roof planes.
