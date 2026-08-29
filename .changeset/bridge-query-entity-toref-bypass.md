---
'@ifc-lite/sandbox': patch
---

`bim.query.entity(modelId, expressId)` built its `EntityRef` directly from the raw arguments instead of going through the shared `toRef()` helper used by every other method in `bim.query`. A wrong-typed `modelId`/`expressId` (from a loosely-typed sandbox script) reached `sdk.entity()` unchecked instead of being rejected like the same shape already is everywhere else in the namespace.

`entity()` now builds its ref via `toRef()` and returns `null` for a shape it rejects, matching the rest of `bim.query`. A script that only ever passes a real `(modelId, expressId)` pair is unaffected.
