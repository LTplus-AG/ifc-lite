---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

The section box caps its cut faces like a section plane does (#8696): every box face that cuts through an element gets a cap, with the same Cap settings (Surfaces / Lines, Uniform or Element colour fill, hatch) and the selection highlight. The box bar now has Fill and the Cap popover. The renderer draws a cap per box face from polygons uploaded under `sectionBoxCapKey(face)`, styled by the new `ClipBox` `showCap` / `showOutlines` / `capStyle`.
