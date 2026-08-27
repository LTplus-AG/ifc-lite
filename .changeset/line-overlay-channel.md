---
'@ifc-lite/renderer': major
---

Replaced the eight per-channel 3D line-overlay methods on `Renderer` with one
`setLineOverlay(channel, vertices)`.

`Renderer` published `uploadAnnotationLines3D`/`clearAnnotationLines3D`,
`uploadAlignmentLines3D`/`clearAlignmentLines3D`, `uploadGridLines3D`/
`clearGridLines3D` and `uploadDxfLines3D`/`clearDxfLines3D` — eight methods that
were each a one-line forward to `RendererOverlays`, which forwarded again to
`Section2DOverlayRenderer`, which held four upload/clear/has/draw quartets over
four `WorldLineBuffer` fields. A fifth overlay channel cost four new methods on
`Section2DOverlayRenderer`, two on `RendererOverlays` and two more on the
published `Renderer`. It now costs one entry in `LINE_OVERLAY_CHANNELS`, one
uniform slot and one row in the bounds-policy table.

The channels stay independent where independence is real. Each still owns its
own vertex buffer and its own uniform slot: the four draws are encoded into one
render pass and `queue.writeBuffer` lands before the pass runs, so a shared
buffer or a shared slot would give all four whatever the last write said. What
collapsed is the lookup, which is the only thing that was ever duplicated.

Removed from `@ifc-lite/renderer`:

- `Renderer.uploadAnnotationLines3D`, `Renderer.clearAnnotationLines3D`
- `Renderer.uploadAlignmentLines3D`, `Renderer.clearAlignmentLines3D`
- `Renderer.uploadGridLines3D`, `Renderer.clearGridLines3D`
- `Renderer.uploadDxfLines3D`, `Renderer.clearDxfLines3D`
- `Section2DOverlayRenderer.upload*/clear*/has*/draw*Lines3D` for the same four
  families — that class is exported too, so its 16 methods are part of the same
  break. They become `setLineOverlay(channel, vertices)`,
  `hasLineOverlay(channel)` and `drawLineOverlay(pass, viewProj, channel)`.

Added: `setLineOverlay(channel, vertices)` on both, plus the
`LineOverlayChannel` type and the `LINE_OVERLAY_CHANNELS` array so callers can
name a channel. `null` clears; an array too short for a whole segment clears
too, exactly as an empty array did before.

Migration is mechanical:

```ts
renderer.uploadGridLines3D(v);  // → renderer.setLineOverlay('grid', v);
renderer.clearGridLines3D();    // → renderer.setLineOverlay('grid', null);
```

The clash-overlap box is deliberately not a channel. It draws in its own colour
rather than the shared overlay colour, and callers reach it through
`setClashOverlapBox` / `setClashContactLines`, which carry that colour.
`setClashBoxLineColor`, `uploadClashBoxLines3D` and friends are unchanged.

Behaviour is unchanged, including the one way the four channels differ:
annotation and alignment uploads still grow the scene AABB and re-fit the
camera, so an annotation-only or alignment-only file with no `IfcProduct` meshes
is still framed by Home / fit-to-view instead of being clipped by the near/far
range; grid axes and the DXF reference layer still do not, so ticking either
visibility toggle still does not reframe the camera. That split now lives in one
`CHANNEL_EXPANDS_MODEL_BOUNDS` table rather than in which of four methods a
caller happened to pick, and `renderer-overlays-line-channels.test.ts` asserts
it per channel through the host calls, which is the only place it is observable.

Major because eight published `Renderer` methods and 16 published
`Section2DOverlayRenderer` methods are removed: a consumer calling any of them
now gets a compile error.

Verified by running: `pnpm build`, `pnpm turbo run typecheck` and the renderer,
viewer and geometry test suites (1144, 6392 and full pass, 0 failures). Both new
assertions were mutation-checked — flipping `grid` to expand model bounds fails
the bounds-policy test, and making the clear branch a no-op fails "a cleared
family stops being drawn" for all four channels.
