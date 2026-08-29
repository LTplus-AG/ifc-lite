---
'@ifc-lite/ifcx': patch
---

Fix `BUILDING_ELEMENT_TYPES` (`packages/ifcx/src/types.ts`), a hand-maintained 15-name list, missing most of the `IfcBuildingElement`/`IfcBuiltElement` family and wrongly including `IfcOpeningElement`.

It is now derived from `@ifc-lite/data`'s generated IFC2X3/IFC4/IFC4X3 entity tables (already a runtime dependency of `@ifc-lite/ifcx`) instead of a hand list, walking `IfcBuildingElement` for IFC2X3/IFC4 and `IfcBuiltElement` for IFC4X3 — IFC4X3 renamed the abstract root, so a naive schema-derived walk of only the IFC4 name would have silently returned nothing for IFC4X3.

Nothing in this repo currently reads `BUILDING_ELEMENT_TYPES` (it is re-exported public API with zero internal consumers), so this changes what the exported set contains for any external consumer of `@ifc-lite/ifcx`, not internal behavior:

- Previously missing even for IFC4: `IfcFooting`, `IfcPile`, `IfcMember`, `IfcPlate`, `IfcShadingDevice`, `IfcChimney`, `IfcStairFlight`, `IfcRampFlight`, `IfcDoorStandardCase`, `IfcWindowStandardCase`.
- Previously entirely absent for IFC4X3's renamed root: `IfcBearing`, `IfcCaissonFoundation`, `IfcCourse`, `IfcDeepFoundation`, `IfcEarthworksFill`, `IfcKerb`, `IfcMooringDevice`, `IfcNavigationElement`, `IfcPavement`, `IfcRail`, `IfcReinforcedSoil`, `IfcTrackElement`.
- Previously wrongly included: `IfcOpeningElement` (a subtraction feature under `IfcFeatureElement`, not a building element).

Adds `building-element-types-authority.test.ts`, mirroring `spatial-types-authority.test.ts` in this same package: it re-derives the full descendant set from the generated schemas and asserts `BUILDING_ELEMENT_TYPES` agrees in both directions, so a future schema bump or hand-edit cannot quietly reopen the gap.
