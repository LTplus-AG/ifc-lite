---
'@ifc-lite/export': minor
---

`Ifc5Exporter` (IFC → IFCX/IFC5) never wrote `bsi::ifc::material`, the only attribute IFCX carries an element's material on — an `IfcRelAssociatesMaterial` association from the STEP source was silently dropped on export, even though our own IFCX reader (`@ifc-lite/ifcx`'s `property-extractor.ts`) already unpacks that attribute into a "Material" pset. The exporter now emits `bsi::ifc::material: { code: <material name> }` for an entity with a resolved material. `uri` is intentionally omitted: unlike an IFC class name, a freeform IFC4 material name has no buildingSMART identifier registry to point at, and fabricating a resolvable-looking URI would misrepresent it as officially registered.
