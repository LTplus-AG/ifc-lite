---
"@ifc-lite/renderer": major
"@ifc-lite/viewer": minor
---

Preview face masks across every resident streaming fragment of one canonical evaluated surface (#4556).

- `@ifc-lite/renderer`: `AppearancePartition` now identifies its canonical source item and full triangle count, and every `AppearancePartitionPart` has a side-local `partId`. Repeated IFC geometry item ids are valid across fragments; validation requires bounded, disjoint, complete canonical coverage and exact full-surface provenance before install or history replay. `validateAppearancePartition` is exported for hosts that construct history transitions.
- Viewer: masked previews split selected and retained faces independently in each streaming fragment, preserve full-surface corner ordinals and retained UV/texture/style references, and join/split all fragments through Compare, Discard, Apply, Undo and Redo. Malformed, overlapping, incomplete, reordered and stale fragment provenance is refused.
