---
'@ifc-lite/collab': patch
---

Fix `applyIfcxOverlay` silently resurrecting an entity a previous, separately-arriving layer had deleted.

`applyIfcxOverlay` writes a file's opinions onto a doc that may already hold the paths involved — used by `mergeBranch(parent, branch, 'layer')` and by any other caller applying a sequence of layers/ops to the same doc. Within one call, a delete-then-resurrect sequence already resolved correctly ("the last opinion wins"), but `deleteEntity` purges the path from `entitiesMap` entirely, so once that call's transaction ended there was nothing left on the doc distinguishing "deleted, no opinion since" from "never existed". A later, separate `applyIfcxOverlay` call touching the same path with no opinion on deletion at all read `hasEntity() === false` as "brand new" and silently recreated the entity via `createNodeEntity`, losing the deletion and every attribute the deleted entity had carried that the new layer did not itself restate. Two layers applied in different orders — a delete-op and an unrelated set-op on the same path — converged to two different final states depending only on which was applied first: order A (delete, then set) left the entity alive; order B (set, then delete) left it deleted.

`applyIfcxOverlay` now records paths it deletes in a small persistent set on the doc's meta map, and a later call that touches such a path without itself stating a deletion opinion leaves it deleted rather than recreating it. An explicit revive (`ifclite::deleted: false`) still resurrects the entity as before, and the tombstone is cleared once it does.
