---
"@ifc-lite/create": minor
---

`landXmlToIfc` converts a parsed LandXML document to IFC4X3, implementing v1.0 of `docs/architecture/landxml-to-ifc-mapping.md` (#4937). A TIN surface becomes `IfcGeographicElement`/`.TERRAIN.` carrying an `IfcTriangulatedIrregularNetwork`; a `CgPoint` becomes `IfcAnnotation`/`.SURVEY.` with a property set; a declared CRS becomes `IfcProjectedCRS` + `IfcMapConversion`.

Purely additive. Every out-of-scope LandXML record family (alignments, profiles, cross sections, roadways, parcels, monuments, plan features, pipe networks, surface breaklines/boundaries/contours) is counted and named rather than dropped, and a source with no mappable record returns `{ status: 'refused' }` rather than a valid, empty IFC. GlobalIds derive deterministically from the LandXML source id; with a fixed `timestampMs`, re-exporting an unchanged source is byte-identical (without one, only the header and owner-history timestamps differ).

`IfcCreator.terrain()` exposes the underlying IFC4X3 terrain/survey emitters directly. It throws on any other schema — `IfcTriangulatedIrregularNetwork` and the `.TERRAIN.`/`.SURVEY.` predefined types do not exist before IFC4X3.
