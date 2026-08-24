---
"@ifc-lite/merge": patch
---

Close a live divergence between `applyNode` and `applyNodeCow` in component-state extraction: `applyNodeCow` silently omitted the `ifclite::deleted` tombstone branch that `applyNode` has, so a `DELETED` opinion reaching it fell through into an ordinary component write instead of setting the entity's `deleted`/`explicitDeleted` flags.

This was safe today only because `projectStackStates` bails to the `extractStackState` fallback (never reaching `applyNodeCow`) whenever any layer in the stack carries a `DELETED` opinion — a behavioural delta held safe by a caller's guard rather than by anything structural, and invisible through the public API.

Both functions now delegate to one shared `applyNodeToEntity` core, parameterised only by whether a touched component is copied before mutation (the one real difference: `applyNodeCow`'s clone-on-write entities may still alias untouched ancestor state). No other branch can drift between the two. No public API change.
