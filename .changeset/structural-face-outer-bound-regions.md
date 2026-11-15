---
"@ifc-lite/parser": patch
---

The structural item reader keeps every region of a face written as several `IfcFaceOuterBound` loops (AxisVM slabs): glyph stations, the centre and the on-face test use all of them, and a loop inside another is read as its opening. A point load on any triangle of such a slab is on the face.
