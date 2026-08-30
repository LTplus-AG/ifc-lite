---
'@ifc-lite/ifcx': major
---

Fix `BUILDING_ELEMENT_TYPES` (`packages/ifcx/src/types.ts`), a hand-maintained 15-name list, missing most of the `IfcBuildingElement`/`IfcBuiltElement` family and wrongly including `IfcOpeningElement`.

It is now derived from `@ifc-lite/data`'s generated IFC2X3/IFC4/IFC4X3 entity tables (already a runtime dependency of `@ifc-lite/ifcx`) instead of a hand list, walking `IfcBuildingElement` for IFC2X3/IFC4 and `IfcBuiltElement` for IFC4X3 — IFC4X3 replaced the family root, so a naive schema-derived walk of only the IFC4 name would have silently returned nothing for IFC4X3. Each root is a member of its own family: `IfcBuildingElement` is abstract in IFC2X3/IFC4, but IFC4X3's `IfcBuiltElement` is concrete, so a file can carry an `IFCBUILTELEMENT` instance and dropping the root would classify it as not a building element. The set is 53 names.

No code in this repo reads `BUILDING_ELEMENT_TYPES` apart from the parity test added below (it is re-exported public API with zero internal consumers), so this changes what the exported set contains for any external consumer of `@ifc-lite/ifcx`, not internal behavior:

- Previously missing even for IFC4: `IfcFooting`, `IfcPile`, `IfcMember`, `IfcPlate`, `IfcShadingDevice`, `IfcChimney`, `IfcStairFlight`, `IfcRampFlight`, `IfcDoorStandardCase`, `IfcWindowStandardCase`.
- Previously entirely absent for IFC4X3's renamed root: `IfcBuiltElement` itself, `IfcBearing`, `IfcCaissonFoundation`, `IfcCourse`, `IfcDeepFoundation`, `IfcEarthworksFill`, `IfcKerb`, `IfcMooringDevice`, `IfcNavigationElement`, `IfcPavement`, `IfcRail`, `IfcReinforcedSoil`, `IfcTrackElement`.
- Previously wrongly included: `IfcOpeningElement` (a subtraction feature under `IfcFeatureElement`, not a building element). This is the breaking part, hence `major`: a consumer on a caret range that reads `BUILDING_ELEMENT_TYPES.has('IfcOpeningElement')` sees `true` become `false`.

Adds `building-element-types-authority.test.ts`, mirroring `spatial-types-authority.test.ts` in this same package: it re-derives the descendant set from the generated schemas with its own copy of the walk and asserts `BUILDING_ELEMENT_TYPES` agrees in both directions — every member of each schema's universe is in the set, and every name in the set is in the union of the three universes — so neither a schema bump that drops a name nor a hand-edit that adds an unrelated class passes unnoticed.
