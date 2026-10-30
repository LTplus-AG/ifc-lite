---
"@ifc-lite/create": patch
---

`extractGridAxesForStorey` now returns each grid axis's ends in authored order: an `IfcGridAxis` with `SameSense = .F.` has its start and end swapped, so `a` is the authored start. The order is decided by one internal helper, `readGridAxisEnds`, which `addColumnOnGridToStore` and the viewer's native-grid certification share. The curve's own `IfcTrimmedCurve.SenseAgreement` is still not read.
