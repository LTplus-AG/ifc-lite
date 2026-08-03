---
"@ifc-lite/mutations": patch
---

Stop `importMutations` from orphaning property/attribute/quantity edits under a created entity it skipped (#2044).

`applyMutations` deliberately skips `CREATE_ENTITY` records — the history alone doesn't carry the type+attributes payload, so callers must restore it via `restoreNewEntity()` — but it still replayed every property, attribute, quantity, and positional-attribute mutation recorded against that entity's expressId. The receiving view ended up with a property set (or attribute/quantity/type edit) keyed to an id that existed in neither the source buffer nor `newEntities`, and reported it as a pending change via `getForEntity()`.

`applyMutations` now skips every mutation recorded against an id whose `CREATE_ENTITY` it skipped in the same batch, keyed off that skip set rather than "id absent from `newEntities`" — so replay against a normal, pre-existing source-buffer entity is unaffected. The round trip for an overlay-created entity is now lossy (the entity and its edits are both dropped) instead of corrupting (edits surviving without their entity). The `console.warn` now also states that dependent mutations were dropped.
