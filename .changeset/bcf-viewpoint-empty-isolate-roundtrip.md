---
"@ifc-lite/bcf": minor
"@ifc-lite/sdk": minor
---

Fix `createViewpoint`/`extractViewpointState` reading an active-but-empty isolation (the viewer isolated to a set that currently matches nothing — an empty viewport) the same as no isolation at all.

- `createViewpoint({ visibleGuids: [] })` (isolation active, zero entities) previously wrote no `components.visibility` at all, so the resulting BCF viewpoint claimed the whole model was visible. It now correctly writes `defaultVisibility: false` with no exceptions. This was reachable via `@ifc-lite/sdk`'s `bim.bcf.createViewpoint()`, which already produced `visibleGuids: []` for `{ defaultVisibility: false, exceptions: [] }` input — a real caller shape, not a hypothetical.
- `extractViewpointState()`'s `visibleGuids` field is now `string[] | null` (was `string[]`): `null` means the read viewpoint carried no isolation channel, while a non-null array — empty included — means isolation was active in the captured viewpoint, down to "matched nothing". A BCF viewpoint from any conformant tool with `<Visibility DefaultVisibility="false"/>` and no `<Exceptions>` is spec-valid and previously round-tripped back as "no isolation" instead of "isolated to nothing". `@ifc-lite/sdk`'s `ExtractedViewpointState.visibleGuids` carries the same type change.

`hiddenGuids` is unaffected: it is a blocklist, where an absent and an empty set both correctly mean "hide nothing" (matching `packages/renderer/src/entity-visibility.ts`'s `isEntityVisible` convention), so it keeps its `.length > 0` check.
