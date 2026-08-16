---
"@ifc-lite/diff": minor
---

Fingerprint an entity's resolved material names, so a re-specified element reads as modified

`DataFingerprintInput` gains an optional `materials?: string[]`, hashed into `buildDataFingerprint` and surfaced as a `material` key by `buildComponentFingerprints`. Material was absent from the projection entirely, so an element whose material changed was reported as unchanged in every channel.

Callers supply **resolved names**, never entity references: an `IfcMaterial`'s express id is reassigned on every save, so a reference comparison reports a change for every material-bearing element of every re-exported model. Names must be resolved through the full indirection (`IfcMaterialLayerSetUsage`, `IfcMaterialProfileSetUsage`, the layer/profile/constituent sets and their wrappers, `IfcMaterialList`), not just a directly attached `IfcMaterial`.

The field is optional and an empty array hashes identically to omitting it, so an adapter that does not supply materials is unaffected: the `Materials` key is written only for an entity that names one, and no existing fingerprint moves.
