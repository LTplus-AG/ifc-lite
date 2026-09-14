---
"@ifc-lite/viewer": patch
---

Fix two "objects with geometry" surfaces #4656/#4658 missed while sweeping the rest of the app onto one rule.

`hierarchy/hierarchyGeometry.ts`'s `buildGeometricIdSet` added only `mesh.expressId`, while `lib/object-count.ts`'s `collectMeshedIds` (the StatusBar's rule, and the rule this fix now shares with) also adds the keys of `instancedGeometryHashes`/`Aabbs`/`Volumes` — entities rendered only through GPU instancing (the same omission #2865 found in clash detection). A fully-instanced element therefore had geometry in the StatusBar and lacked it in the hierarchy trees, disappearing from By Class and By Type. `buildGeometricIdSet` now delegates to `collectMeshedIds` for both the federated and legacy paths instead of re-deriving the rule; no local/global id conversion was needed, since a federated model's `geometryResult` ids and its instanced side-channel keys are already in the same global space.

`ModelMetadataPanel`'s "Elements with Geometry" row summed `spatialHierarchy.byStorey` array lengths — raw `IfcRelContainedInSpatialStructure` membership, with neither the schema filter (`isPhysicalObjectType`) nor a shape filter the label claims. A storey holding an `IfcBuildingElementProxy` with `Representation = $` (no shape) read one higher than the hierarchy trees and the StatusBar, which both already applied the filter. The row now goes through the same `collectPhysicalEntityIds` + `countShapedObjects` composition as the rest of the app (`components/viewer/properties/modelMetadataStats.ts`), with an explicit `geometryReady` flag so a still-streaming model shows every physical element instead of flashing 0 before its first geometry result lands.
