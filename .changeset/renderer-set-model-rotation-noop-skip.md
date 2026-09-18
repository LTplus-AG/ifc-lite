---
"@ifc-lite/renderer": patch
---

`Renderer.setModelRotation` now returns a `boolean` (`Scene.setModelRotation`'s own "did anything change" result) and skips its cache clear / placement-bounds refresh when the call was a no-op — an unchanged angle/pivot, or a translation-only viewer update that pushes every model's UNCHANGED heading on every placement edit (#4890 review). No caller had to change: the return value is additive.
