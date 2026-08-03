---
"@ifc-lite/mutations": patch
---

Drop component ops for entities whose final change-set state is `tombstone-entity` (#2048).

`changeSetToOps` folds `entityOps` (last-write-wins per entity) and `components` (per componentKey) in the same pass over the mutation list, but previously emitted every accumulated component op regardless of whether the entity ended up deleted. A `CREATE_PROPERTY` mutation followed later by `DELETE_ENTITY` for the same entity produced both a `tombstone-entity` op and a `set-component` op carrying the now-meaningless property values — which `apps/viewer`'s `buildDeltaNodes` merged onto the same `IfcxNode`, publishing live property values alongside `IFCLITE_ATTR.DELETED: true`.

Component ops are now filtered against each entity's final `entityOps` state after both passes complete (not during the fold, since an entity's terminal state — LWW — is only known once the whole mutation list has been consumed). An entity tombstoned and then recreated in the same change set keeps its components, since `entityOps` resolves to `add-entity` for that identity.
