---
'@ifc-lite/renderer': minor
'@ifc-lite/viewer': patch
---

Stop grid BUBBLES from framing the camera.

**The second half of #3359.** Routing grid lines to their own `grid` channel (#3381) fixed the line half: the renderer decides whether a 3D line overlay grows the scene AABB per CHANNEL, and `grid` deliberately does not, because a grid reaches past the model envelope and framing on it throws the model off screen (#967).

Bubbles never travelled that route. A grid bubble is a text plus a fill, and both reach the renderer through `uploadAnnotationTexts3D` / `uploadAnnotationFills3D`, which have no channel to key a policy on and grew the bounds unconditionally. They are also the outermost grid content there is, sitting `BUBBLE_OFFSET_M` beyond each axis endpoint, so with the lines correctly routed an annotations-off / grid-on session still reframed the camera on grid extent.

**Added:** an optional `definesExtent?: boolean` on `SymbolicTextInput` and `SymbolicFillInput`. `false` draws the item without letting the scene AABB grow to it. It defaults to `true`, so an existing caller that omits it keeps the behaviour it had — that is what makes this additive rather than breaking. (The one deliberate exception is the fill re-fit described below.) Per ITEM rather than per call because both uploads REPLACE the whole array, so a caller cannot split one annotation call and one grid call. That is a property of today's pipeline, not of the problem; a channel-keyed upload matching `setLineOverlay` would delete the flag, and it needs per-channel buffers.

**One behaviour change beyond the flag:** `uploadAnnotationFills3D` used to re-fit the camera's scene bounds on every call, including a clear that changed nothing. It now re-fits only when a fill actually moved the bounds, which is how `uploadAnnotationTexts3D` and `setLineOverlay` have always behaved.

**The trade-off, stated:** a model whose only content is the symbolic grid now has nothing defining an extent, so the camera keeps the placeholder AABB the geometry pipeline seeds when there are zero meshes. That is consistent with how `grid` already treated the lines, so it makes one rule out of two rather than introducing a second. Real IFCs with grids nearly always carry meshes.

The viewer now passes its annotation records straight to the two uploads instead of remapping them field by field. They are structurally assignable to the renderer's input types and the renderer copies only its declared fields, so the mapping was a hand-written field list whose only real property was that `definesExtent` could be forgotten from it. `definesExtent` is required on the viewer's own record types, so an omission is now a compile error at the point the record is built.
