---
'@ifc-lite/export': patch
---

STEP export is deterministic again for IFC4X3 models targeting IFC4. Every
IFC4X3-only class is downgraded to an `IFCPROXY` placeholder, and each one was
minted a fresh GlobalId on every export, so exporting an unchanged model twice
never produced the same bytes and anything keyed on GlobalId across exports lost
its association.

The placeholder id is now derived from the source line. Re-exporting an
unchanged model reproduces it, while two federated occurrences of the same
entity still get distinct ids, because the merged exporter offsets each model's
express ids. A caller-supplied seeded `RandomSource` still takes precedence.
