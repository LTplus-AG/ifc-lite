---
"@ifc-lite/create": patch
---

fix(create): every in-store builder now emits geometry in the model's
native length unit. Wall, slab, beam, column, door, window, roof, plate,
and member wrote metre coordinates regardless of the file's length unit —
an element added to a millimetre model (typical Revit export) serialized
1000× too small, while its in-session mesh (built separately in renderer
metres) looked correct until the export round-trip. The duplicate flow
had the inverse bug: its metre offset was added to the source's
native-unit location, so a duplicate in a mm file landed ~1000× too
close (visually on top of the source). Door/window OverallHeight /
OverallWidth attributes are converted too. Completes the conversion the
space builder received in #1029 via `SpatialAnchor.lengthUnitScale`.
