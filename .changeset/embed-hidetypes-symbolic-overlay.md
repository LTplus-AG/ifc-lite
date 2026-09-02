---
'@ifc-lite/viewer-embed': patch
'@ifc-lite/embed-sdk': patch
'@ifc-lite/viewer': patch
---

Let `hideTypes` reach the symbolic 2D overlay, so `hideTypes: ['IfcAnnotation']` stops being a silent no-op.

`IfcAnnotation` 2D content is not a mesh. Rust routes every shape representation identified `Plan`, `Annotation`, `FootPrint` or `Axis` into symbolic data (`rust/processing/src/symbolic/mod.rs`), which the viewport draws as a line-and-text overlay gated only on the store's `typeVisibility.ifcAnnotations` and `.ifcGrid`. The embed's `hideTypes` filters the mesh list, so it could never touch that overlay: a host naming `IfcAnnotation` got silence and no error (#2934). Measured on AC20-FZK-Haus through the real embed build, five states pixel-diffed against each other: before this change `hideTypes=IfcAnnotation` moved 0 of 960,000 pixels, while turning the store's own annotation toggle off moved 6,492 — the same 6,492 that stripping the 14 `IFCANNOTATION` instances out of the bytes moves. After it, the `hideTypes` states are pixel-identical to both (0 px apart), by either host route: `INIT`'s `config.hideTypes` and `?hideTypes=`.

The embed now publishes its case-folded hidden-class set to `store.hostHiddenIfcTypes`, and the two overlay hooks read it there, beside the per-entity hides they already apply, through one pure function (`lib/symbolic-overlay-gate.ts`). Nothing is threaded through `Viewport`: the overlay is built two levels below it, and a prop would have added a link only `Viewport` could keep honest — and no test mounts `Viewport`, which needs a WebGPU device.

**What `hideTypes` matches, for the 2D overlay.** The class that OWNS the drawn content, taken from the one table the overlay parse itself uses (`lib/overlay-parse/overlay-channels.ts`): dimensions, leaders and room tags are `IfcAnnotation`; grid axes and their bubbles are `IfcGridAxis`, not `IfcGrid`, which owns no drawn content and so hides nothing. Naming a wall or a space removes their meshes and no 2D content — their `Axis` / `FootPrint` representations are not drawn in the 3D viewport at all (they reach the 2D drawing generator, which this does not gate). Should a channel ever draw a second owner class, it switches off only when every class it draws is hidden, so hiding one class can never take another's content with it.

Precedence is unchanged: `hideTypes` and the store toggles both apply, and a class named in `hideTypes` stays hidden when a later `SET_TYPE_VISIBILITY` turns its toggle on, exactly as a hidden `IfcSpace` mesh behaves today. The full viewer sets no host list and renders as before.
