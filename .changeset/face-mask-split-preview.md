---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

Face selection for evaluated occurrence appearance (#4404, closes the F6 slice).

- `@ifc-lite/renderer`: an appearance preview owner can declare an `AppearancePartition` (`AppearancePreviewOptions.partition`, recorded on `AppearanceChange.partition`, inverted for history with `invertAppearancePartition`). The controller then accepts a replacement that repartitions the owner's items — one evaluated surface into a textured and a retained face set, or the join back — after proving corner-for-corner position equality, identical placement frame and ownership, and that both sides name every triangle of the shared reference surface exactly once. Everything else about the one-to-one contract is unchanged.
- Viewer: the appearance workspace previews a face-masked plan as two parts of the same product instead of refusing it — the selected faces textured, the rest keeping the source style — and Compare, Discard, Apply, Undo and Redo work on the split. Converted objects gain a **Select faces** editor on their evaluated surface (click toggles a face, a marquee adds faces, Alt removes, "All faces" clears); the selection is session state bound to the planner's `surfaceFingerprint`, is dropped with a visible diagnostic when the planner reports the surface stale or the object already carries a direct tessellated Body (after Apply), never persists to IFC, and clears on model change or reload. Portable IFCZIP export and reopening a face-masked export tessellate the product into its two face sets under one selectable product.
