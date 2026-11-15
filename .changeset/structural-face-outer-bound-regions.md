---
"@ifc-lite/parser": patch
---

The structural item reader keeps every region of a face written as several `IfcFaceOuterBound` loops (AxisVM slabs): the on-face test and the centre use all of them, the 3 x 3 lattice spans their union, and a region the lattice misses gets a station of its own (at most nine), and a loop inside another is read as its opening. A point load on any triangle of such a slab is on the face.
