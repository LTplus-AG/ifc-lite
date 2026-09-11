---
"@ifc-lite/bcf": major
"@ifc-lite/sdk": minor
---

Fix `createViewpoint`/`extractViewpointState` reading an active-but-empty isolation (the viewer isolated to a set that currently matches nothing — an empty viewport) the same as no isolation at all.

- `createViewpoint({ visibleGuids: [] })` (isolation active, zero entities) previously wrote no `components.visibility` at all, so the resulting BCF viewpoint claimed the whole model was visible. It now correctly writes `defaultVisibility: false` with no exceptions. This was reachable via `@ifc-lite/sdk`'s `bim.bcf.createViewpoint()`, which already produced `visibleGuids: []` for `{ defaultVisibility: false, exceptions: [] }` input — a real caller shape, not a hypothetical.
- `extractViewpointState()`'s `visibleGuids` field is now `string[] | null` (was `string[]`): `null` means the read viewpoint carried no isolation channel, while a non-null array — empty included — means isolation was active in the captured viewpoint, down to "matched nothing". A BCF viewpoint from any conformant tool with `<Visibility DefaultVisibility="false"/>` and no `<Exceptions>` is spec-valid and previously round-tripped back as "no isolation" instead of "isolated to nothing". `@ifc-lite/sdk`'s `ExtractedViewpointState.visibleGuids` carries the same type change.

- `bim.bcf.createViewpoint()`'s `components.visibility.defaultVisibility` is now **optional**, and an absent value is read as `true`, per BCF's schema default ("everything is visible, the exceptions are HIDDEN"). It was previously truthy-tested, which mapped an absent value onto the isolation arm — inverting the spec's default, and, with no exceptions to isolate, turning a caller who said nothing about visibility into a viewpoint asserting a blank viewport. Pass `defaultVisibility: false` explicitly to isolate.

`hiddenGuids` is unaffected: it is a blocklist, where an absent and an empty set both correctly mean "hide nothing" (matching `packages/renderer/src/entity-visibility.ts`'s `isEntityVisible` convention), so it keeps its `.length > 0` check.

When both `visibleGuids` and `hiddenGuids` are supplied, the isolation allowlist wins and the blocklist is not written. That is deliberate and lossless rather than a dropped input: BCF's `<Visibility>` carries a single `DefaultVisibility` flag, so only one of the two modes is expressible at all, and an allowlist already hides everything outside itself.
