---
'@ifc-lite/viewer': patch
---

Turning "Show IFC Annotations" off while leaving the IfcGrid toggle on no longer reframes the camera onto the grid.

`useSymbolicAnnotations` lifted IfcAnnotation curves AND IfcGridAxis lines into one buffer uploaded to the renderer's `annotation` line-overlay channel. With annotations off and the grid on, that buffer carried only grid content, but `CHANNEL_EXPANDS_MODEL_BOUNDS.annotation` is `true` — the policy exists so an annotation-only model can still be framed — so the grid-only upload grew the scene bounds that `CHANNEL_EXPANDS_MODEL_BOUNDS.grid: false` exists to protect (grid axes routinely extend far past the model envelope, issue #967). Every later camera fit and every empty-space orbit gesture (whose pivot falls back to the scene-bounds centroid, `useMouseControls.ts`/`useTouchControls.ts`) then reframed around the inflated bounds instead of the model.

`useSymbolicAnnotations` now returns the two content kinds separately (`{ annotation, grid }`), and the viewport uploads each to its own channel, so grid content reaches the policy it was designed for.
