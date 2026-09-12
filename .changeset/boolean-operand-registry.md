---
"@ifc-lite/wasm": patch
---

Boolean operands now dispatch from the same built-in processor table the geometry router uses, so every representation item the engine can mesh is also a valid `IfcBooleanResult` / `IfcBooleanClippingResult` operand (#4560). The boolean path previously kept its own six-type list; a cutter of any other type — `IfcPolygonalFaceSet` first of all, which Bonsai/IfcOpenShell emits for a wall clipped by a roof, but also tapered, surface-curve and sectioned sweeps, advanced breps, spheres and TINs — meshed empty, and the host rendered un-cut (the wall ran up to the ridge) with only an `UnsupportedOperand` diagnostic. Unregistered types still resolve to an empty operand and record `UnsupportedOperand`.
