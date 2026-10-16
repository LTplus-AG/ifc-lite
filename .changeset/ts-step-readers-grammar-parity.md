---
"@ifc-lite/encoding": minor
"@ifc-lite/data": patch
"@ifc-lite/parser": patch
"@ifc-lite/export": patch
---

TS STEP readers match the core grammar (#7785, #7790): `parseStepValue` keeps an overflowing REAL such as `1.E400` as raw text instead of `Infinity`; `readRefList` and the list/attribute splitters (`parseStepList`, the viewer schedule stripper) skip `/* ... */` comments through one shared `splitStepTopLevel` in `@ifc-lite/encoding`; `generateLod0` walks `PlacementRelTo` iteratively and refuses a cyclic placement, reporting the element in the new optional `skipped` list instead of overflowing the stack.
