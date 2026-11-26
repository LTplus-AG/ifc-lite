# @ifc-lite/validate parity report

Generated 2026-11-26 by `parity/run-parity.ts`. Oracle: ifcopenshell.validate (express_rules=True) 0.9.0.post1.
Findings are compared per rule and instance. TP: both report it; FP: only we do; FN: only the oracle does.

## Rule compilation

| Schema | Scope | Entity WHERE | Type WHERE | Global | Compiled |
|---|---|---:|---:|---:|---:|
| IFC4_ADD2_TC1 | all | 652/652 | 25/25 | 2/2 | 100% |
| IFC4_ADD2_TC1 | authoring | 95/95 | 13/13 | 2/2 | 100% |
| IFC4X3_DEV_923b0514 | all | 752/752 | 25/25 | 2/2 | 100% |
| IFC4X3_DEV_923b0514 | authoring | 101/101 | 13/13 | 2/2 | 100% |
| IFC2X3 | all | 339/339 | 24/24 | 2/2 | 100% |

Every WHERE rule, DERIVE expression, FUNCTION and global RULE compiled; nothing is reported as not evaluated.

## Totals

131 files: TP 313, FP 3, FN 0. FN on the crafted corpus: 0.

## Targeted defects (crafted corpus)

| File | Targets | We detect | Oracle detects |
|---|---|---|---|
| broken/wall-userdefined-without-objecttype.ifc | `IfcWall.CorrectPredefinedType` | yes | yes |
| broken/door-typed-by-wall-type.ifc | `IfcDoor.CorrectStyleAssigned` | yes | yes |
| broken/window-typed-by-wall-type.ifc | `IfcWindow.CorrectStyleAssigned` | yes | yes |
| broken/slab-userdefined-without-objecttype.ifc | `IfcSlab.CorrectPredefinedType` | yes | yes |
| broken/space-userdefined-without-objecttype.ifc | `IfcSpace.CorrectPredefinedType` | yes | yes |
| broken/wall-typed-by-slab-type.ifc | `IfcWall.CorrectTypeAssigned` | yes | yes |
| broken/walltype-without-name.ifc | `IfcTypeObject.NameRequired` | yes | yes |
| broken/storey-not-aggregated.ifc | `IfcSpatialStructureElement.WR41` | yes | yes |
| broken/aggregates-self-reference.ifc | `IfcRelAggregates.NoSelfReference` | yes | yes |
| broken/storey-contained-in-storey.ifc | `IfcRelContainedInSpatialStructure.WR31` | yes | yes |
| broken/project-without-name.ifc | `IfcProject.HasName` | yes | yes |
| broken/project-subcontext.ifc | `IfcProject.CorrectContext` | yes | yes |
| broken/two-projects.ifc | `global:IfcSingleProjectInstance` | yes | yes |
| broken/axis-without-refdirection.ifc | `IfcAxis2Placement3D.AxisAndRefDirProvision` | yes | yes |
| broken/placement-location-2d.ifc | `IfcAxis2Placement3D.LocationIs3D` | yes | yes |
| broken/placement-parallel-axes.ifc | `IfcAxis2Placement3D.AxisToRefDirPosition` | yes | yes |
| broken/direction-zero.ifc | `IfcDirection.MagnitudeGreaterZero` | yes | yes |
| broken/point-one-coordinate.ifc | `IfcCartesianPoint.CP2Dor3D` | yes | yes |
| broken/extrusion-in-profile-plane.ifc | `IfcExtrudedAreaSolid.ValidExtrusionDirection` | yes | yes |
| broken/rectangle-zero-width.ifc | `IfcPositiveLengthMeasure.WR1` | yes | yes |
| broken/shape-without-type.ifc | `IfcShapeRepresentation.HasRepresentationType` | yes | yes |
| broken/shape-wrong-type.ifc | `IfcShapeRepresentation.CorrectItemsForType` | yes | yes |
| broken/shape-in-non-geometric-context.ifc | `IfcShapeRepresentation.CorrectContext` | yes | yes |
| broken/shape-shared-by-two-products.ifc | `IfcShapeModel.WR11` | yes | yes |
| broken/local-placement-3d-under-2d.ifc | `IfcLocalPlacement.WR21` | yes | yes |
| broken/subcontext-userdefined-view.ifc | `IfcGeometricRepresentationSubContext.UserTargetProvided` | yes | yes |
| broken/subcontext-explicit-derived.ifc | `derived-in-subtype` | yes | **no** |
| broken/pset-without-name.ifc | `IfcPropertySet.ExistsName` | yes | yes |
| broken/pset-duplicate-property-names.ifc | `IfcPropertySet.UniquePropertyNames` | yes | yes |
| broken/two-psets-same-name.ifc | `IfcObject.UniquePropertySetNames` | yes | yes |
| broken/quantity-negative-length.ifc | `IfcQuantityLength.WR22` | yes | yes |
| broken/unit-wrong-dimensions.ifc | `IfcNamedUnit.WR1` | yes | yes |
| broken/unit-assignment-duplicate-type.ifc | `IfcUnitAssignment.WR01` | yes | yes |
| broken/ownerhistory-added-without-date.ifc | `IfcOwnerHistory.CorrectChangeAction` | yes | yes |
| broken/person-without-name.ifc | `IfcPerson.IdentifiablePerson` | yes | yes |
| broken/grid-without-placement.ifc | `IfcGrid.HasPlacement` | yes | yes |
| broken/grid-axis-3d-curve.ifc | `IfcGridAxis.WR1` | yes | yes |
| broken/polyline-mixed-dimensions.ifc | `IfcPolyline.SameDim` | yes | yes |
| broken/profile-outer-curve-3d.ifc | `IfcArbitraryClosedProfileDef.WR1` | yes | yes |
| broken/material-priority-out-of-range.ifc | `IfcMaterialLayer.NormalizedPriority` | yes | yes |
| broken/wallstandardcase-without-layer-usage.ifc | `IfcWallStandardCase.HasMaterialLayerSetUsage` | yes | yes |
| broken/opening-voids-nothing.ifc | `inverse-cardinality` | yes | yes |
| broken/door-fills-two-openings.ifc | `inverse-cardinality` | yes | yes |
| broken/wall-contained-twice.ifc | `inverse-cardinality` | yes | yes |
| broken/defines-by-properties-on-type.ifc | `IfcRelDefinesByProperties.NoRelatedTypeObject` | yes | yes |
| broken/duplicate-globalid.ifc | `IfcRoot.UR1` | yes | yes |
| broken/globalid-invalid-characters.ifc | `guid-format` | yes | yes |
| broken/wall-missing-globalid.ifc | `not-optional` | yes | yes |
| broken/wall-name-integer.ifc | `invalid-type` | yes | yes |
| broken/wall-placement-wrong-entity.ifc | `invalid-type` | yes | yes |
| broken/point-integer-coordinates.ifc | `invalid-type` | yes | yes |
| broken/wall-enum-unknown-item.ifc | `invalid-type` | yes | yes |
| broken/wall-attribute-count.ifc | `attribute-count` | yes | yes |
| broken/abstract-entity-instance.ifc | `abstract` | yes | yes |
| broken/select-untyped-value.ifc | `invalid-type` | yes | yes |
| broken/typed-value-in-plain-slot.ifc | `invalid-type` | yes | yes |
| broken/header-author-not-list.ifc | `FILE_NAME.author` | yes | yes |
| ifc4x3/broken/wall-userdefined-without-objecttype.ifc | `IfcWall.CorrectPredefinedType` | yes | yes |
| ifc4x3/broken/slab-userdefined-without-objecttype.ifc | `IfcSlab.CorrectPredefinedType` | yes | yes |
| ifc4x3/broken/space-userdefined-without-objecttype.ifc | `IfcSpace.CorrectPredefinedType` | yes | yes |
| ifc4x3/broken/wall-typed-by-slab-type.ifc | `IfcWall.CorrectTypeAssigned` | yes | yes |
| ifc4x3/broken/walltype-without-name.ifc | `IfcTypeObject.NameRequired` | yes | yes |
| ifc4x3/broken/storey-not-aggregated.ifc | `IfcSpatialStructureElement.WR41` | yes | yes |
| ifc4x3/broken/aggregates-self-reference.ifc | `IfcRelAggregates.NoSelfReference` | yes | yes |
| ifc4x3/broken/storey-contained-in-storey.ifc | `IfcRelContainedInSpatialStructure.WR31` | yes | yes |
| ifc4x3/broken/project-without-name.ifc | `IfcProject.HasName` | yes | yes |
| ifc4x3/broken/project-subcontext.ifc | `IfcProject.CorrectContext` | yes | yes |
| ifc4x3/broken/two-projects.ifc | `global:IfcSingleProjectInstance` | yes | yes |
| ifc4x3/broken/axis-without-refdirection.ifc | `IfcAxis2Placement3D.AxisAndRefDirProvision` | yes | yes |
| ifc4x3/broken/placement-location-2d.ifc | `IfcAxis2Placement3D.LocationIs3D` | yes | yes |
| ifc4x3/broken/placement-parallel-axes.ifc | `IfcAxis2Placement3D.AxisToRefDirPosition` | yes | yes |
| ifc4x3/broken/direction-zero.ifc | `IfcDirection.MagnitudeGreaterZero` | yes | yes |
| ifc4x3/broken/point-one-coordinate.ifc | `IfcCartesianPoint.CP2Dor3D` | yes | yes |
| ifc4x3/broken/extrusion-in-profile-plane.ifc | `IfcExtrudedAreaSolid.ValidExtrusionDirection` | yes | yes |
| ifc4x3/broken/rectangle-zero-width.ifc | `IfcPositiveLengthMeasure.WR1` | yes | yes |
| ifc4x3/broken/shape-without-type.ifc | `IfcShapeRepresentation.HasRepresentationType` | yes | yes |
| ifc4x3/broken/shape-wrong-type.ifc | `IfcShapeRepresentation.CorrectItemsForType` | yes | yes |
| ifc4x3/broken/shape-in-non-geometric-context.ifc | `IfcShapeRepresentation.CorrectContext` | yes | yes |
| ifc4x3/broken/shape-shared-by-two-products.ifc | `IfcShapeModel.WR11` | yes | yes |
| ifc4x3/broken/local-placement-3d-under-2d.ifc | `IfcLocalPlacement.WR21` | yes | yes |
| ifc4x3/broken/subcontext-userdefined-view.ifc | `IfcGeometricRepresentationSubContext.UserTargetProvided` | yes | yes |
| ifc4x3/broken/subcontext-explicit-derived.ifc | `derived-in-subtype` | yes | **no** |
| ifc4x3/broken/pset-without-name.ifc | `IfcPropertySet.ExistsName` | yes | yes |
| ifc4x3/broken/pset-duplicate-property-names.ifc | `IfcPropertySet.UniquePropertyNames` | yes | yes |
| ifc4x3/broken/two-psets-same-name.ifc | `IfcObject.UniquePropertySetNames` | yes | yes |
| ifc4x3/broken/quantity-negative-length.ifc | `IfcQuantityLength.WR22` | yes | yes |
| ifc4x3/broken/unit-wrong-dimensions.ifc | `IfcNamedUnit.WR1` | yes | yes |
| ifc4x3/broken/unit-assignment-duplicate-type.ifc | `IfcUnitAssignment.WR01` | yes | yes |
| ifc4x3/broken/ownerhistory-added-without-date.ifc | `IfcOwnerHistory.CorrectChangeAction` | yes | yes |
| ifc4x3/broken/person-without-name.ifc | `IfcPerson.IdentifiablePerson` | yes | yes |
| ifc4x3/broken/grid-axis-3d-curve.ifc | `IfcGridAxis.WR1` | yes | yes |
| ifc4x3/broken/polyline-mixed-dimensions.ifc | `IfcPolyline.SameDim` | yes | yes |
| ifc4x3/broken/profile-outer-curve-3d.ifc | `IfcArbitraryClosedProfileDef.WR1` | yes | yes |
| ifc4x3/broken/material-priority-out-of-range.ifc | `IfcMaterialLayer.NormalizedPriority` | yes | yes |
| ifc4x3/broken/wallstandardcase-without-layer-usage.ifc | `IfcWallStandardCase.HasMaterialLayerSetUsage` | yes | yes |
| ifc4x3/broken/opening-voids-nothing.ifc | `inverse-cardinality` | yes | yes |
| ifc4x3/broken/door-fills-two-openings.ifc | `inverse-cardinality` | yes | yes |
| ifc4x3/broken/wall-contained-twice.ifc | `inverse-cardinality` | yes | yes |
| ifc4x3/broken/defines-by-properties-on-type.ifc | `IfcRelDefinesByProperties.NoRelatedTypeObject` | yes | yes |
| ifc4x3/broken/duplicate-globalid.ifc | `IfcRoot.UR1` | yes | yes |
| ifc4x3/broken/globalid-invalid-characters.ifc | `guid-format` | yes | yes |
| ifc4x3/broken/wall-missing-globalid.ifc | `not-optional` | yes | yes |
| ifc4x3/broken/wall-name-integer.ifc | `invalid-type` | yes | yes |
| ifc4x3/broken/wall-placement-wrong-entity.ifc | `invalid-type` | yes | yes |
| ifc4x3/broken/point-integer-coordinates.ifc | `invalid-type` | yes | yes |
| ifc4x3/broken/wall-enum-unknown-item.ifc | `invalid-type` | yes | yes |
| ifc4x3/broken/wall-attribute-count.ifc | `attribute-count` | yes | yes |
| ifc4x3/broken/abstract-entity-instance.ifc | `abstract` | yes | yes |
| ifc4x3/broken/select-untyped-value.ifc | `invalid-type` | yes | yes |
| ifc4x3/broken/typed-value-in-plain-slot.ifc | `invalid-type` | yes | yes |
| ifc4x3/broken/header-author-not-list.ifc | `FILE_NAME.author` | yes | yes |

## Per rule, crafted corpus

| Rule | TP | FP | FN | TN files | Explanation |
|---|---:|---:|---:|---:|---|
| `derived-in-subtype` | 0 | 2 | 0 | 114 | FP: ISO 10303-21 requires `*` in a slot a subtype redeclares as DERIVE (IfcGeometricRepresentationSubContext.CoordinateSpaceDimension). IfcOpenShell does not report a value written there; the corpus file subcontext-explicit-derived.ifc shows it. |
| `abstract` | 4 | 0 | 0 | 112 |  |
| `attribute-count` | 2 | 0 | 0 | 114 |  |
| `evaluation-error:ifcgeometricrepresentationcontext.north2d` | 4 | 0 | 0 | 114 |  |
| `evaluation-error:ifcobject.uniquepropertysetnames` | 2 | 0 | 0 | 114 |  |
| `evaluation-error:ifcshaperepresentation.correctitemsfortype` | 2 | 0 | 0 | 114 |  |
| `global:ifcsingleprojectinstance` | 2 | 0 | 0 | 114 |  |
| `guid-format` | 2 | 0 | 0 | 114 |  |
| `header:file_name.author` | 2 | 0 | 0 | 114 |  |
| `ifcarbitraryclosedprofiledef.wr1` | 2 | 0 | 0 | 114 |  |
| `ifcaxis2placement2d.locationis2d` | 2 | 0 | 0 | 114 |  |
| `ifcaxis2placement3d.axisandrefdirprovision` | 2 | 0 | 0 | 114 |  |
| `ifcaxis2placement3d.axistorefdirposition` | 2 | 0 | 0 | 114 |  |
| `ifcaxis2placement3d.locationis3d` | 2 | 0 | 0 | 114 |  |
| `ifccartesianpoint.cp2dor3d` | 2 | 0 | 0 | 114 |  |
| `ifcdirection.magnitudegreaterzero` | 2 | 0 | 0 | 114 |  |
| `ifcdoor.correctstyleassigned` | 1 | 0 | 0 | 115 |  |
| `ifcdoor.correcttypeassigned` | 1 | 0 | 0 | 115 |  |
| `ifcextrudedareasolid.validextrusiondirection` | 2 | 0 | 0 | 114 |  |
| `ifcgeometricrepresentationsubcontext.usertargetprovided` | 2 | 0 | 0 | 114 |  |
| `ifcgrid.hasplacement` | 1 | 0 | 0 | 115 |  |
| `ifcgridaxis.wr1` | 2 | 0 | 0 | 114 |  |
| `ifclocalplacement.wr21` | 4 | 0 | 0 | 112 |  |
| `ifcmateriallayer.normalizedpriority` | 2 | 0 | 0 | 114 |  |
| `ifcnamedunit.wr1` | 2 | 0 | 0 | 114 |  |
| `ifcobject.uniquepropertysetnames` | 2 | 0 | 0 | 114 |  |
| `ifcownerhistory.correctchangeaction` | 2 | 0 | 0 | 114 |  |
| `ifcperson.identifiableperson` | 2 | 0 | 0 | 114 |  |
| `ifcpolyline.samedim` | 2 | 0 | 0 | 114 |  |
| `ifcpositioningelement.hasplacement` | 1 | 0 | 0 | 115 |  |
| `ifcpositivelengthmeasure.wr1` | 2 | 0 | 0 | 114 |  |
| `ifcproject.correctcontext` | 2 | 0 | 0 | 114 |  |
| `ifcproject.hasname` | 2 | 0 | 0 | 114 |  |
| `ifcpropertyset.existsname` | 2 | 0 | 0 | 114 |  |
| `ifcpropertyset.uniquepropertynames` | 2 | 0 | 0 | 114 |  |
| `ifcquantitylength.wr22` | 2 | 0 | 0 | 114 |  |
| `ifcrelaggregates.noselfreference` | 2 | 0 | 0 | 114 |  |
| `ifcrelcontainedinspatialstructure.wr31` | 2 | 0 | 0 | 114 |  |
| `ifcreldefinesbyproperties.norelatedtypeobject` | 2 | 0 | 0 | 114 |  |
| `ifcshapemodel.wr11` | 4 | 0 | 0 | 114 |  |
| `ifcshaperepresentation.correctcontext` | 2 | 0 | 0 | 114 |  |
| `ifcshaperepresentation.correctitemsfortype` | 2 | 0 | 0 | 114 |  |
| `ifcshaperepresentation.hasrepresentationtype` | 2 | 0 | 0 | 114 |  |
| `ifcslab.correctpredefinedtype` | 2 | 0 | 0 | 114 |  |
| `ifcspace.correctpredefinedtype` | 2 | 0 | 0 | 114 |  |
| `ifcspatialstructureelement.wr41` | 4 | 0 | 0 | 112 |  |
| `ifctypeobject.namerequired` | 2 | 0 | 0 | 114 |  |
| `ifcunitassignment.wr01` | 2 | 0 | 0 | 114 |  |
| `ifcwall.correctpredefinedtype` | 2 | 0 | 0 | 114 |  |
| `ifcwall.correcttypeassigned` | 4 | 0 | 0 | 114 |  |
| `ifcwallstandardcase.hasmateriallayersetusage` | 2 | 0 | 0 | 114 |  |
| `ifcwindow.correctstyleassigned` | 1 | 0 | 0 | 115 |  |
| `ifcwindow.correcttypeassigned` | 1 | 0 | 0 | 115 |  |
| `invalid-type` | 12 | 0 | 0 | 104 |  |
| `inverse-cardinality` | 10 | 0 | 0 | 106 |  |
| `not-optional` | 2 | 0 | 0 | 114 |  |
| `unique:ifcroot.ur1` | 2 | 0 | 0 | 114 |  |

## Per rule, whole corpus

| Rule | TP | FP | FN | TN files | Explanation |
|---|---:|---:|---:|---:|---|
| `derived-in-subtype` | 0 | 2 | 0 | 129 | FP: ISO 10303-21 requires `*` in a slot a subtype redeclares as DERIVE (IfcGeometricRepresentationSubContext.CoordinateSpaceDimension). IfcOpenShell does not report a value written there; the corpus file subcontext-explicit-derived.ifc shows it. |
| `global:ifcrepresentationcontextsamewcs` | 0 | 1 | 0 | 130 | FP: The rule tests `WorldCoordinateSystem :<>: ...`, instance inequality (ISO 10303-11 12.2.2). IfcOpenShell compiles it to `!=` under compare_instances_by_value, so two distinct but equal-valued placements skip the precision check. We keep instance semantics: the two contexts carry precisions $ and 1E-5. |
| `abstract` | 4 | 0 | 0 | 127 |  |
| `attribute-count` | 2 | 0 | 0 | 129 |  |
| `evaluation-error:ifcgeometricrepresentationcontext.north2d` | 4 | 0 | 0 | 129 |  |
| `evaluation-error:ifcobject.uniquepropertysetnames` | 2 | 0 | 0 | 129 |  |
| `evaluation-error:ifcshaperepresentation.correctitemsfortype` | 2 | 0 | 0 | 129 |  |
| `global:ifcsingleprojectinstance` | 2 | 0 | 0 | 129 |  |
| `guid-format` | 2 | 0 | 0 | 129 |  |
| `header:file_name.author` | 3 | 0 | 0 | 128 |  |
| `header:file_name.organization` | 1 | 0 | 0 | 130 |  |
| `ifcarbitraryclosedprofiledef.wr1` | 2 | 0 | 0 | 129 |  |
| `ifcarbitraryopenprofiledef.wr12` | 4 | 0 | 0 | 130 |  |
| `ifcaxis2placement2d.locationis2d` | 2 | 0 | 0 | 129 |  |
| `ifcaxis2placement3d.axisandrefdirprovision` | 2 | 0 | 0 | 129 |  |
| `ifcaxis2placement3d.axistorefdirposition` | 2 | 0 | 0 | 129 |  |
| `ifcaxis2placement3d.locationis3d` | 2 | 0 | 0 | 129 |  |
| `ifccartesianpoint.cp2dor3d` | 2 | 0 | 0 | 129 |  |
| `ifcdirection.magnitudegreaterzero` | 2 | 0 | 0 | 129 |  |
| `ifcdoor.correctstyleassigned` | 1 | 0 | 0 | 130 |  |
| `ifcdoor.correcttypeassigned` | 1 | 0 | 0 | 130 |  |
| `ifcextrudedareasolid.validextrusiondirection` | 2 | 0 | 0 | 129 |  |
| `ifcgeometricrepresentationsubcontext.usertargetprovided` | 2 | 0 | 0 | 129 |  |
| `ifcgrid.hasplacement` | 1 | 0 | 0 | 130 |  |
| `ifcgridaxis.wr1` | 2 | 0 | 0 | 129 |  |
| `ifclocalplacement.wr21` | 4 | 0 | 0 | 127 |  |
| `ifcmateriallayer.normalizedpriority` | 2 | 0 | 0 | 129 |  |
| `ifcnamedunit.wr1` | 2 | 0 | 0 | 129 |  |
| `ifcobject.uniquepropertysetnames` | 2 | 0 | 0 | 129 |  |
| `ifcownerhistory.correctchangeaction` | 3 | 0 | 0 | 128 |  |
| `ifcperson.identifiableperson` | 2 | 0 | 0 | 129 |  |
| `ifcpolyline.samedim` | 2 | 0 | 0 | 129 |  |
| `ifcpositioningelement.hasplacement` | 1 | 0 | 0 | 130 |  |
| `ifcpositivelengthmeasure.wr1` | 2 | 0 | 0 | 129 |  |
| `ifcpositiveratiomeasure.wr1` | 8 | 0 | 0 | 130 |  |
| `ifcproject.correctcontext` | 2 | 0 | 0 | 129 |  |
| `ifcproject.hasname` | 2 | 0 | 0 | 129 |  |
| `ifcpropertyset.existsname` | 2 | 0 | 0 | 129 |  |
| `ifcpropertyset.uniquepropertynames` | 2 | 0 | 0 | 129 |  |
| `ifcquantitylength.wr22` | 11 | 0 | 0 | 128 |  |
| `ifcrelaggregates.noselfreference` | 2 | 0 | 0 | 129 |  |
| `ifcrelcontainedinspatialstructure.wr31` | 2 | 0 | 0 | 129 |  |
| `ifcreldefinesbyproperties.norelatedtypeobject` | 2 | 0 | 0 | 129 |  |
| `ifcrelspaceboundary.correctphysorvirt` | 5 | 0 | 0 | 130 |  |
| `ifcshapemodel.wr11` | 144 | 0 | 0 | 128 |  |
| `ifcshaperepresentation.correctcontext` | 2 | 0 | 0 | 129 |  |
| `ifcshaperepresentation.correctitemsfortype` | 2 | 0 | 0 | 129 |  |
| `ifcshaperepresentation.hasrepresentationtype` | 2 | 0 | 0 | 129 |  |
| `ifcslab.correctpredefinedtype` | 2 | 0 | 0 | 129 |  |
| `ifcspace.correctpredefinedtype` | 2 | 0 | 0 | 129 |  |
| `ifcspatialstructureelement.wr41` | 4 | 0 | 0 | 127 |  |
| `ifctypeobject.namerequired` | 4 | 0 | 0 | 128 |  |
| `ifcunitassignment.wr01` | 2 | 0 | 0 | 129 |  |
| `ifcwall.correctpredefinedtype` | 2 | 0 | 0 | 129 |  |
| `ifcwall.correcttypeassigned` | 4 | 0 | 0 | 129 |  |
| `ifcwallstandardcase.hasmateriallayersetusage` | 2 | 0 | 0 | 129 |  |
| `ifcwindow.correctstyleassigned` | 1 | 0 | 0 | 130 |  |
| `ifcwindow.correcttypeassigned` | 1 | 0 | 0 | 130 |  |
| `invalid-type` | 12 | 0 | 0 | 119 |  |
| `inverse-cardinality` | 11 | 0 | 0 | 120 |  |
| `not-optional` | 7 | 0 | 0 | 128 |  |
| `unique:ifcroot.ur1` | 2 | 0 | 0 | 129 |  |

## Files

| File | Schema | Ours | Oracle | TP | FP | FN | ms |
|---|---|---:|---:|---:|---:|---:|---:|
| packages/validate/parity/corpus/base-ifc4.ifc | IFC4_ADD2_TC1 | 0 | 0 | 0 | 0 | 0 | 31 |
| packages/validate/parity/corpus/ifc4x3/base.ifc | IFC4X3_DEV_923b0514 | 0 | 0 | 0 | 0 | 0 | 33 |
| packages/validate/parity/corpus/broken/wall-userdefined-without-objecttype.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 2 |
| packages/validate/parity/corpus/broken/door-typed-by-wall-type.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/window-typed-by-wall-type.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 2 |
| packages/validate/parity/corpus/broken/slab-userdefined-without-objecttype.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/space-userdefined-without-objecttype.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/wall-typed-by-slab-type.ifc | IFC4_ADD2_TC1 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/walltype-without-name.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/storey-not-aggregated.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/aggregates-self-reference.ifc | IFC4_ADD2_TC1 | 3 | 3 | 3 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/storey-contained-in-storey.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/project-without-name.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/project-subcontext.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/two-projects.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/axis-without-refdirection.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/placement-location-2d.ifc | IFC4_ADD2_TC1 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/placement-parallel-axes.ifc | IFC4_ADD2_TC1 | 3 | 3 | 3 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/direction-zero.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/point-one-coordinate.ifc | IFC4_ADD2_TC1 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/extrusion-in-profile-plane.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/rectangle-zero-width.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/shape-without-type.ifc | IFC4_ADD2_TC1 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/shape-wrong-type.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/shape-in-non-geometric-context.ifc | IFC4_ADD2_TC1 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/shape-shared-by-two-products.ifc | IFC4_ADD2_TC1 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/local-placement-3d-under-2d.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/subcontext-userdefined-view.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 4 |
| packages/validate/parity/corpus/broken/subcontext-explicit-derived.ifc | IFC4_ADD2_TC1 | 1 | 0 | 0 | 1 | 0 | 0 |
| packages/validate/parity/corpus/broken/pset-without-name.ifc | IFC4_ADD2_TC1 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/pset-duplicate-property-names.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/two-psets-same-name.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/quantity-negative-length.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/unit-wrong-dimensions.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/unit-assignment-duplicate-type.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/ownerhistory-added-without-date.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/person-without-name.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/grid-without-placement.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/grid-axis-3d-curve.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/polyline-mixed-dimensions.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/profile-outer-curve-3d.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/material-priority-out-of-range.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/wallstandardcase-without-layer-usage.ifc | IFC4_ADD2_TC1 | 2 | 2 | 2 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/opening-voids-nothing.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/door-fills-two-openings.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/wall-contained-twice.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/defines-by-properties-on-type.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/duplicate-globalid.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/globalid-invalid-characters.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/wall-missing-globalid.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/wall-name-integer.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/wall-placement-wrong-entity.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 2 |
| packages/validate/parity/corpus/broken/point-integer-coordinates.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/wall-enum-unknown-item.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/wall-attribute-count.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/abstract-entity-instance.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/broken/select-untyped-value.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/typed-value-in-plain-slot.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/broken/header-author-not-list.ifc | IFC4_ADD2_TC1 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/wall-userdefined-without-objecttype.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/door-typed-by-wall-type.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/window-typed-by-wall-type.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/slab-userdefined-without-objecttype.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/space-userdefined-without-objecttype.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/wall-typed-by-slab-type.ifc | IFC4X3_DEV_923b0514 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/walltype-without-name.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/storey-not-aggregated.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/aggregates-self-reference.ifc | IFC4X3_DEV_923b0514 | 3 | 3 | 3 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/storey-contained-in-storey.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/project-without-name.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/project-subcontext.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/two-projects.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/axis-without-refdirection.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/placement-location-2d.ifc | IFC4X3_DEV_923b0514 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/placement-parallel-axes.ifc | IFC4X3_DEV_923b0514 | 3 | 3 | 3 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/direction-zero.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/point-one-coordinate.ifc | IFC4X3_DEV_923b0514 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/extrusion-in-profile-plane.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/rectangle-zero-width.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/shape-without-type.ifc | IFC4X3_DEV_923b0514 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/shape-wrong-type.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/shape-in-non-geometric-context.ifc | IFC4X3_DEV_923b0514 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/shape-shared-by-two-products.ifc | IFC4X3_DEV_923b0514 | 2 | 2 | 2 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/local-placement-3d-under-2d.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/subcontext-userdefined-view.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/subcontext-explicit-derived.ifc | IFC4X3_DEV_923b0514 | 1 | 0 | 0 | 1 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/pset-without-name.ifc | IFC4X3_DEV_923b0514 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/pset-duplicate-property-names.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/two-psets-same-name.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/quantity-negative-length.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/unit-wrong-dimensions.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/unit-assignment-duplicate-type.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/ownerhistory-added-without-date.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/person-without-name.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/grid-without-placement.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/grid-axis-3d-curve.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/polyline-mixed-dimensions.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/profile-outer-curve-3d.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/material-priority-out-of-range.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/wallstandardcase-without-layer-usage.ifc | IFC4X3_DEV_923b0514 | 2 | 2 | 2 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/opening-voids-nothing.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/door-fills-two-openings.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/wall-contained-twice.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/defines-by-properties-on-type.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/duplicate-globalid.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/globalid-invalid-characters.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/wall-missing-globalid.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/wall-name-integer.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/wall-placement-wrong-entity.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/point-integer-coordinates.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/wall-enum-unknown-item.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/wall-attribute-count.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/abstract-entity-instance.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/select-untyped-value.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| packages/validate/parity/corpus/ifc4x3/broken/typed-value-in-plain-slot.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 0 |
| packages/validate/parity/corpus/ifc4x3/broken/header-author-not-list.ifc | IFC4X3_DEV_923b0514 | 1 | 1 | 1 | 0 | 0 | 1 |
| tests/models/ara3d/AC20-FZK-Haus.ifc | IFC4_ADD2_TC1 | 170 | 170 | 170 | 0 | 0 | 192 |
| tests/models/ara3d/IfcOpenHouse_IFC4.ifc | IFC4_ADD2_TC1 | 0 | 0 | 0 | 0 | 0 | 8 |
| tests/models/buildingsmart/Building-Architecture.ifc | IFC4_ADD2_TC1 | 0 | 0 | 0 | 0 | 0 | 9 |
| tests/models/buildingsmart/Building-Structural.ifc | IFC4_ADD2_TC1 | 0 | 0 | 0 | 0 | 0 | 9 |
| tests/models/buildingsmart/wall-with-opening-and-window.ifc | IFC4_ADD2_TC1 | 0 | 0 | 0 | 0 | 0 | 1 |
| tests/models/buildingsmart/Infra-Road.ifc | IFC4_ADD2_TC1 | 0 | 0 | 0 | 0 | 0 | 15 |
| tests/models/buildingsmart/Infra-Bridge.ifc | IFC4_ADD2_TC1 | 0 | 0 | 0 | 0 | 0 | 54 |
| tests/models/modelling/saved-building.ifc | IFC4_ADD2_TC1 | 0 | 0 | 0 | 0 | 0 | 2 |
| tests/models/various/issue-604-door.ifc | IFC4_ADD2_TC1 | 4 | 4 | 4 | 0 | 0 | 9 |
| tests/models/ara3d/duplex.ifc | IFC2X3 | 0 | 0 | 0 | 0 | 0 | 174 |
| tests/models/buildingsmart/annex_e/basic-geometric-shape/extruded-solid.ifc | IFC4X3_DEV_923b0514 | 0 | 0 | 0 | 0 | 0 | 0 |
| tests/models/buildingsmart/annex_e/tessellated-shape/polygonal-face-tessellation.ifc | IFC4X3_DEV_923b0514 | 0 | 0 | 0 | 0 | 0 | 1 |
| tests/models/ifcopenshell/generated_structural_coverage_ifc4x3.ifc | IFC4X3_DEV_923b0514 | 0 | 0 | 0 | 0 | 0 | 1 |
| apps/viewer/public/samples/hello-wall.ifc | IFC4_ADD2_TC1 | 2 | 2 | 2 | 0 | 0 | 5 |
| apps/viewer/public/samples/building-architecture-rev-b.ifc | IFC4_ADD2_TC1 | 2 | 1 | 1 | 1 | 0 | 8 |

