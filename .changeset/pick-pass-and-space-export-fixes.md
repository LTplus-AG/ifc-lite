---
"@ifc-lite/renderer": patch
"@ifc-lite/create": patch
"@ifc-lite/viewer": patch
---

fix(renderer): double-sided GPU pick pass — back-face culling could cull an
element's entire camera-facing surface (IFC winding order varies), so clicks
selected whatever was behind it (e.g. an IfcSpace behind a wall).

fix(create): space bakes now survive the IFC round-trip —
`addSpaceToStore` emits geometry in the model's native length unit
(a space baked into a millimetre model used to export 1000× too small),
and `resolveSpatialAnchor` no longer fails on models without
`IfcOwnerHistory` (OPTIONAL from IFC4 onward); builders emit `$` instead.

fix(viewer): Space Sketch surfaces real bake errors instead of counting
them as "already a space" skips, reveals the (persisted) Spaces class
visibility after a successful bake, and the toolbar button is edit-mode
gated with a distinct icon.
