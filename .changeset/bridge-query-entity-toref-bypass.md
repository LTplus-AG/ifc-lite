---
'@ifc-lite/sandbox': patch
---

`bim.query.entity(modelId, expressId)` built its `EntityRef` inline from the raw arguments, with type casts and no runtime check, instead of going through the shared `toRef()` helper that every other method in `bim.query` uses. A call that omitted an argument — `bim.query.entity('m1')` — therefore reached `sdk.entity()` with `expressId: undefined` instead of being rejected first.

`entity()` now builds its ref via `toRef()` and returns `null` when the ref is unusable, matching the rest of `bim.query`. A script that passes a real `(modelId, expressId)` pair is unaffected, and so is a wrong-typed one: the bridge coerces argument 0 with `getString` and argument 1 with `getNumber` before the handler runs, so `bim.query.entity(42, '7')` arrived — and still arrives — as `('42', 7)`.
