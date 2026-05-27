---
"@ifc-lite/viewer": patch
"@ifc-lite/wasm": patch
---

Improve IFC annotation legibility in 3D (issue #812 follow-up):

- **All annotation text now billboards to the camera.** Previously only
  IfcGridAxis tags rebuilt in the screen-aligned basis; IfcAnnotation
  text (dimensions, leader labels, room tags) kept its authored
  in-plane orientation. In oblique views that text collapsed to a
  smeared sliver of pixels — the "distorted dimension labels in
  FZK-Haus" symptom from the issue. The shader path was already
  per-instance billboard-aware, so the change is just a flag flip at
  upload time; anchor and alignment are unchanged.

- **Grid bubbles no longer paint a white disc behind the tag.** The
  bubble interior is now transparent, so geometry behind a grid line
  reads through the bubble in 3D. The black outline ring (◯) and tag
  glyph are unchanged — the white ● fill instance has been removed
  from `emit_bubble`, which also drops one text instance per bubble.
