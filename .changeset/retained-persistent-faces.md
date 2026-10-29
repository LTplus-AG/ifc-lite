---
"@ifc-lite/wasm": minor
"@ifc-lite/cli": minor
---

Retained products now carry persistent IFC face identity: every published triangle has a source key `#item[>#opening]:role` (cap, profile side, disk wall/cap), derived from the product's own authored recipes and cross-checked against the kernel's faces, so `PersistentFaces` is no longer listed as unmet. A product whose faces cannot be proven refuses `face_provenance_unproven` (cause `unattributed` or `ambiguous`) instead of publishing a guess. The CLI report's optional per-part `faces` rows are now populated; retained OBJ geometry lines and the default exact engine are unchanged.
