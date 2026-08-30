---
"@ifc-lite/renderer": major
---

**BREAKING.** Five changes to what `@ifc-lite/renderer` publishes. `Renderer.getScene()` now returns a measured interface instead of the `Scene` class, and `Scene` itself is no longer exported. The four 3D line-overlay channels collapse from 24 per-channel methods into one `setLineOverlay(channel, vertices)`, and `Section2DOverlayRenderer` is no longer exported either. `PickingManager` is unexported as well, for the reason below.

## `getScene()` returns `SceneContents`

`Renderer` published 70 methods, and several handed the implementation straight across the package boundary. `getScene()` returned `Scene` (4,429 lines, 86 public methods), so the interface a consumer had to learn was `Renderer` plus the whole of that class, and every method added to `Scene` silently became published API. That is the definition of a shallow module: an interface about as complex as the implementation behind it.

`getScene()` now returns `SceneContents`, an interface naming the 46 members actually reached from outside the package. It is exported from the package root, so a consumer can name the type it is holding. The other 40 stay behind the seam.

The member list is a measurement, not a design sketch. Every `renderer.getScene()` call site in `apps/viewer` and `apps/viewer-embed` was resolved with the TypeScript checker and the returned value followed through locals, class fields, object-literal properties, parameters and named-function returns until it was dereferenced, with no unfollowable escapes. A second, independent type-directed sweep over every property access whose object type resolves to `Scene` agreed, and found one extra member the flow scan structurally cannot see (a scene passed to a parameter typed as a caller-side structural interface), which is included. `Scene` did NOT gain an `implements` clause: that would let the class's surface drift wider again without the interface noticing, so the check that `Scene` still satisfies the shape is the `return` inside the accessor, which stops compiling the moment a signature diverges.

`getCamera()` is deliberately unchanged and still returns `Camera`. The same measurement found callers using 39 of `Camera`'s 44 public methods, so an interface there would have frozen five members and named itself a narrowing it had not performed.

`getPipeline()` and `getGPUDevice()` are likewise not narrowed. The scan found zero `RenderPipeline` members and exactly one `GPUDevice` member (`queue`, for `queue.onSubmittedWorkDone()`) reached from outside the package: every other call site takes the handle, null-checks it, and passes it straight back into a `SceneContents` upload method typed for the real `GPUDevice` and `RenderPipeline`. A narrower return type there would break those call sites and buy nothing.

`Renderer.getRaycaster()` and `Renderer.getSnapDetector()` are removed. Both were dead: a repo-wide search, including the aliasing forms a plain identifier search misses (`renderer['getRaycaster']`, `.bind`, destructuring off a `Renderer`), found no caller anywhere. `Raycaster` and `SnapDetector` are both exported from the package root and neither takes constructor arguments, so a consumer that wants either can construct it directly. Reaching the `Renderer`'s own instances is no longer possible: `raycastEngine` is private with no accessor. Building your own `RaycastEngine` is possible and needs nothing unpublished. Its constructor took the concrete `Scene`; it takes `SceneContents` now, because the six scene members it reaches (`getMeshes`, `getBatchedMeshes`, `getMeshDataPieces`, `getInstancedEntityIds`, `getInstancedEntityBounds`, `getInstancedMeshDataPieces`) are all already in `SceneContents`. `new RaycastEngine(renderer.getCamera(), renderer.getScene(), canvas)` type-checks against the built declarations. It is a fresh engine and not the `Renderer`'s: it has its own BVH cache, and no point-cloud snap provider until you call `setPointCloudProvider`. Nothing in this repository did any of that, and if you were, say so in an issue and the accessor comes back with a stated contract rather than by accident.

## `Scene` is no longer exported

Narrowing `getScene()` closed the accessor path and left the export path open. `export { Scene }` still stood in the package barrel, so the sentence `SceneContents` exists to falsify, "every method added to `Scene` silently became published API", stayed literally true: `scripts/api-surface.json` still recorded `Scene: class`, and `import { Scene } from '@ifc-lite/renderer'` still handed a consumer the whole 4,429-line class. It is removed, so `SceneContents` is now the only way across the boundary. Nothing outside `packages/renderer/src` imported `Scene` by name: `useGeometryStreaming.ts` was the last one and it moved to `SceneContents` earlier in this same major.

`PickingManager` goes with it, and the reasoning is worth stating because it was the one thing unexporting `Scene` forced. Its constructor takes the concrete `Scene`, so once `Scene` is internal a consumer could hold the class and never build one. It could not be narrowed the way `RaycastEngine` was: it also reaches `raycast`, `selectRect`, `getInstancedTemplates` and `isGeometryDataReleased`, and the `SceneContents` measurement found none of those four reached from outside the package. Publishing them would have widened a measured interface into a brand, purely to keep an unused export constructible. So it is unexported instead. Nothing outside `packages/renderer/src` constructs one; picking goes through `Renderer.pick` and `Renderer.pickRect`. If you were constructing one directly, open an issue and it gets a stated constructor contract rather than an accidental one.

## One `setLineOverlay` for the four line-overlay channels

`Renderer` published `uploadAnnotationLines3D`/`clearAnnotationLines3D`, `uploadAlignmentLines3D`/`clearAlignmentLines3D`, `uploadGridLines3D`/`clearGridLines3D` and `uploadDxfLines3D`/`clearDxfLines3D` — eight methods, each a one-line forward to `RendererOverlays`, which forwarded again to `Section2DOverlayRenderer`, which held four upload/clear/has/draw quartets over four `WorldLineBuffer` fields. A fifth channel cost four new methods on `Section2DOverlayRenderer`, two on `RendererOverlays` and two more on the published `Renderer`. It now costs five table rows and no new methods: `LINE_OVERLAY_CHANNELS`, `SECTION_2D_UNIFORM_SLOT_INDEX`, `SECTION_2D_UNIFORM_SLOT_COUNT`, the `lineOverlays` record and `CHANNEL_EXPANDS_MODEL_BOUNDS`. Four of those five refuse to compile if you skip them; `SECTION_2D_UNIFORM_SLOT_COUNT` is a hand-written literal that does not, and deriving it from the slot index is a follow-up.

Removed:

- `Renderer.upload*Lines3D` / `Renderer.clear*Lines3D` for all four families
- `Section2DOverlayRenderer` itself, which is no longer exported: `import { Section2DOverlayRenderer } from '@ifc-lite/renderer'` stops resolving, and that class export is the break. Its 16 `upload*/clear*/has*/draw*Lines3D` methods for the same four families go with it, but as an internal refactor rather than a published method removal, because the class carrying them is internal now. Of the 24 methods this section collapses, only the eight on `Renderer` are a break a consumer can call today.

Added: `setLineOverlay(channel, vertices)` on `Renderer`, and on the now-internal `Section2DOverlayRenderer` behind it, plus the `LineOverlayChannel` type and the `LINE_OVERLAY_CHANNELS` array so callers can name a channel. `null` clears; an array too short for a whole segment clears too, exactly as an empty array did before.

The channels stay independent where independence is real. Each still owns its own vertex buffer and its own uniform slot: the four draws are encoded into one render pass and `queue.writeBuffer` lands before the pass runs, so a shared buffer or a shared slot would give all four whatever the last write said (#1277). What collapsed is the lookup, which is the only thing that was ever duplicated.

Behaviour is unchanged, including the one way the four channels differ: annotation and alignment uploads still grow the scene AABB and re-fit the camera, so an annotation-only or alignment-only file with no `IfcProduct` meshes is still framed by Home / fit-to-view instead of being clipped by the near/far range; grid axes (#967) and the DXF reference layer (#2043) still do not, so ticking either visibility toggle still does not reframe the camera. That split now lives in one `CHANNEL_EXPANDS_MODEL_BOUNDS` table rather than in which of four methods a caller happened to pick.

The clash-overlap box is deliberately not a channel. It draws in its own colour rather than the shared overlay colour, and callers reach it through `setClashOverlapBox` / `setClashContactLines`, which carry that colour. `setClashBoxLineColor`, `uploadClashBoxLines3D` and friends are unchanged.

## Migrating

```ts
renderer.uploadGridLines3D(v);  // → renderer.setLineOverlay('grid', v);
renderer.clearGridLines3D();    // → renderer.setLineOverlay('grid', null);
```

`import { Scene }` and `import { Section2DOverlayRenderer }` no longer resolve. Annotate the scene with `SceneContents`, and drive the line overlays through `Renderer.setLineOverlay`.

Code that only calls methods on the value `getScene()` returns needs no change. Code that annotates it as `Scene` should annotate it as `SceneContents`; that was the single break inside this repository. Code that needs a `Scene` member absent from `SceneContents` has found a gap in the measurement, so please open an issue naming the member: adding one is a published-API decision rather than a detail, and the interface's module doc says so at the top.
