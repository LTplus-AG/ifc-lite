/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One defect per corpus file, each aimed at a rule of the authoring subset. */

import { DEFAULT_HEADER, guid, type Records } from './base-model.js';

export interface Mutation {
  name: string;
  /** The rule (or schema check) the defect targets, in report notation. */
  targets: string;
  apply(r: Records): void | { header: typeof DEFAULT_HEADER };
}

function edit(r: Records, id: number, from: string | RegExp, to: string): void {
  const body = r.get(id);
  if (body === undefined) throw new Error(`no record #${id}`);
  const next = body.replace(from, to);
  if (next === body) throw new Error(`mutation did not change #${id}: ${String(from)}`);
  r.set(id, next);
}

const next = (r: Records) => Math.max(...r.keys()) + 1;

export const MUTATIONS: Mutation[] = [
  { name: 'wall-userdefined-without-objecttype', targets: 'IfcWall.CorrectPredefinedType', apply: (r) => edit(r, 42, '.STANDARD.', '.USERDEFINED.') },
  { name: 'door-typed-by-wall-type', targets: 'IfcDoor.CorrectStyleAssigned', apply: (r) => edit(r, 49, '(#42,#60)', '(#42,#60,#62)') },
  { name: 'window-typed-by-wall-type', targets: 'IfcWindow.CorrectStyleAssigned', apply: (r) => edit(r, 49, '(#42,#60)', '(#42,#60,#73)') },
  { name: 'slab-userdefined-without-objecttype', targets: 'IfcSlab.CorrectPredefinedType', apply: (r) => edit(r, 88, '.FLOOR.', '.USERDEFINED.') },
  { name: 'space-userdefined-without-objecttype', targets: 'IfcSpace.CorrectPredefinedType', apply: (r) => edit(r, 101, '.INTERNAL.', '.USERDEFINED.') },
  { name: 'wall-typed-by-slab-type', targets: 'IfcWall.CorrectTypeAssigned', apply: (r) => edit(r, 48, /^IFCWALLTYPE\((.*),\.STANDARD\.\)$/, 'IFCSLABTYPE($1,.FLOOR.)') },
  { name: 'walltype-without-name', targets: 'IfcTypeObject.NameRequired', apply: (r) => edit(r, 48, "'Wall 200'", '$') },
  { name: 'storey-not-aggregated', targets: 'IfcSpatialStructureElement.WR41', apply: (r) => { r.delete(29); } },
  { name: 'aggregates-self-reference', targets: 'IfcRelAggregates.NoSelfReference', apply: (r) => edit(r, 102, '(#101)', '(#101,#26)') },
  { name: 'storey-contained-in-storey', targets: 'IfcRelContainedInSpatialStructure.WR31', apply: (r) => edit(r, 120, '#119)', '#119,#101)') },
  { name: 'project-without-name', targets: 'IfcProject.HasName', apply: (r) => edit(r, 20, "'Project'", '$') },
  { name: 'project-subcontext', targets: 'IfcProject.CorrectContext', apply: (r) => edit(r, 20, '(#15)', '(#15,#16)') },
  { name: 'two-projects', targets: 'global:IfcSingleProjectInstance', apply: (r) => { r.set(next(r), `IFCPROJECT(${guid()},#5,'Second',$,$,$,$,(#15),#10)`); } },
  { name: 'axis-without-refdirection', targets: 'IfcAxis2Placement3D.AxisAndRefDirProvision', apply: (r) => edit(r, 14, '#11,#12,#13', '#11,#12,$') },
  { name: 'placement-location-2d', targets: 'IfcAxis2Placement3D.LocationIs3D', apply: (r) => edit(r, 92, '#93', '#37') },
  { name: 'placement-parallel-axes', targets: 'IfcAxis2Placement3D.AxisToRefDirPosition', apply: (r) => edit(r, 14, '#11,#12,#13', '#11,#12,#12') },
  { name: 'direction-zero', targets: 'IfcDirection.MagnitudeGreaterZero', apply: (r) => edit(r, 32, '(1.,0.)', '(0.,0.)') },
  { name: 'point-one-coordinate', targets: 'IfcCartesianPoint.CP2Dor3D', apply: (r) => edit(r, 55, '(0.5,0.1)', '(0.5)') },
  { name: 'extrusion-in-profile-plane', targets: 'IfcExtrudedAreaSolid.ValidExtrusionDirection', apply: (r) => edit(r, 35, '#14,#12,3.', '#14,#13,3.') },
  { name: 'rectangle-zero-width', targets: 'IfcPositiveLengthMeasure.WR1', apply: (r) => edit(r, 34, '5.,0.2', '5.,0.') },
  { name: 'shape-without-type', targets: 'IfcShapeRepresentation.HasRepresentationType', apply: (r) => edit(r, 85, "'SweptSolid'", '$') },
  { name: 'shape-wrong-type', targets: 'IfcShapeRepresentation.CorrectItemsForType', apply: (r) => edit(r, 85, "'SweptSolid'", "'Brep'") },
  { name: 'shape-in-non-geometric-context', targets: 'IfcShapeRepresentation.CorrectContext', apply: (r) => {
    const ctx = next(r);
    r.set(ctx, "IFCREPRESENTATIONCONTEXT('Plain','Notes')");
    edit(r, 85, '#16,', `#${ctx},`);
  } },
  { name: 'shape-shared-by-two-products', targets: 'IfcShapeModel.WR11', apply: (r) => edit(r, 91, '(#94,#95)', '(#94,#36)') },
  { name: 'local-placement-3d-under-2d', targets: 'IfcLocalPlacement.WR21', apply: (r) => edit(r, 50, '#30,#51', '#30,#33') },
  { name: 'subcontext-userdefined-view', targets: 'IfcGeometricRepresentationSubContext.UserTargetProvided', apply: (r) => edit(r, 16, '.MODEL_VIEW.', '.USERDEFINED.') },
  { name: 'subcontext-explicit-derived', targets: 'derived-in-subtype', apply: (r) => edit(r, 17, "'Model',*,*,*,*,", "'Model',3,*,*,*,") },
  { name: 'pset-without-name', targets: 'IfcPropertySet.ExistsName', apply: (r) => edit(r, 132, "'Pset_WallCommon'", '$') },
  { name: 'pset-duplicate-property-names', targets: 'IfcPropertySet.UniquePropertyNames', apply: (r) => edit(r, 131, "'IsExternal'", "'FireRating'") },
  { name: 'two-psets-same-name', targets: 'IfcObject.UniquePropertySetNames', apply: (r) => {
    const [pset, rel] = [next(r), next(r) + 1];
    r.set(pset, `IFCPROPERTYSET(${guid()},#5,'Pset_WallCommon',$,(#131))`);
    r.set(rel, `IFCRELDEFINESBYPROPERTIES(${guid()},#5,$,$,(#42),#${pset})`);
  } },
  { name: 'quantity-negative-length', targets: 'IfcQuantityLength.WR22', apply: (r) => edit(r, 134, '5.', '-5.') },
  { name: 'unit-wrong-dimensions', targets: 'IfcNamedUnit.WR1', apply: (r) => edit(r, 7, '.SQUARE_METRE.', '.METRE.') },
  { name: 'unit-assignment-duplicate-type', targets: 'IfcUnitAssignment.WR01', apply: (r) => {
    const id = next(r);
    r.set(id, 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
    edit(r, 10, '#9))', `#9,#${id}))`);
  } },
  { name: 'ownerhistory-added-without-date', targets: 'IfcOwnerHistory.CorrectChangeAction', apply: (r) => edit(r, 5, '.NOCHANGE.', '.ADDED.') },
  { name: 'person-without-name', targets: 'IfcPerson.IdentifiablePerson', apply: (r) => edit(r, 1, "$,'Doe','Jane'", '$,$,$') },
  { name: 'grid-without-placement', targets: 'IfcGrid.HasPlacement', apply: (r) => edit(r, 119, "'Grid',$,$,#118,", "'Grid',$,$,$,") },
  { name: 'grid-axis-3d-curve', targets: 'IfcGridAxis.WR1', apply: (r) => {
    const [a, b, c] = [next(r), next(r) + 1, next(r) + 2];
    r.set(a, 'IFCCARTESIANPOINT((0.,-1.,0.))');
    r.set(b, 'IFCCARTESIANPOINT((0.,6.,0.))');
    r.set(c, `IFCPOLYLINE((#${a},#${b}))`);
    edit(r, 113, '#112', `#${c}`);
  } },
  { name: 'polyline-mixed-dimensions', targets: 'IfcPolyline.SameDim', apply: (r) => edit(r, 39, '(#37,#38)', '(#37,#52)') },
  { name: 'profile-outer-curve-3d', targets: 'IfcArbitraryClosedProfileDef.WR1', apply: (r) => {
    const [a, b, c] = [next(r), next(r) + 1, next(r) + 2];
    r.set(a, 'IFCCARTESIANPOINT((5.,0.,0.))');
    r.set(b, 'IFCCARTESIANPOINT((5.,5.,0.))');
    r.set(c, `IFCPOLYLINE((#11,#${a},#${b},#11))`);
    edit(r, 83, '#82', `#${c}`);
  } },
  { name: 'material-priority-out-of-range', targets: 'IfcMaterialLayer.NormalizedPriority', apply: (r) => edit(r, 44, /,\$\)$/, ',150)') },
  { name: 'wallstandardcase-without-layer-usage', targets: 'IfcWallStandardCase.HasMaterialLayerSetUsage', apply: (r) => { r.delete(47); } },
  { name: 'opening-voids-nothing', targets: 'inverse-cardinality', apply: (r) => { r.delete(72); } },
  { name: 'door-fills-two-openings', targets: 'inverse-cardinality', apply: (r) => edit(r, 75, '#70,#73', '#70,#62') },
  { name: 'wall-contained-twice', targets: 'inverse-cardinality', apply: (r) => { r.set(next(r), `IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid()},#5,$,$,(#42),#101)`); } },
  { name: 'defines-by-properties-on-type', targets: 'IfcRelDefinesByProperties.NoRelatedTypeObject', apply: (r) => edit(r, 133, '(#42)', '(#42,#48)') },
  { name: 'duplicate-globalid', targets: 'IfcRoot.UR1', apply: (r) => edit(r, 60, /^IFCWALLSTANDARDCASE\('[^']*'/, `IFCWALLSTANDARDCASE(${/^IFCWALL\(('[^']*')/.exec(r.get(42)!)![1]}`) },
  { name: 'globalid-invalid-characters', targets: 'guid-format', apply: (r) => edit(r, 42, /^IFCWALL\('[^']*'/, "IFCWALL('9!invalid-guid-chars!!x'") },
  { name: 'wall-missing-globalid', targets: 'not-optional', apply: (r) => edit(r, 42, /^IFCWALL\('[^']*'/, 'IFCWALL($') },
  { name: 'wall-name-integer', targets: 'invalid-type', apply: (r) => edit(r, 42, "'Wall A'", '42') },
  { name: 'wall-placement-wrong-entity', targets: 'invalid-type', apply: (r) => edit(r, 42, '#30,#41', '#11,#41') },
  { name: 'point-integer-coordinates', targets: 'invalid-type', apply: (r) => edit(r, 52, '(1.,0.,0.)', '(1,0,0)') },
  { name: 'wall-enum-unknown-item', targets: 'invalid-type', apply: (r) => edit(r, 42, '.STANDARD.', '.CURVED.') },
  { name: 'wall-attribute-count', targets: 'attribute-count', apply: (r) => edit(r, 42, '.STANDARD.)', '.STANDARD.,$)') },
  { name: 'abstract-entity-instance', targets: 'abstract', apply: (r) => { r.set(next(r), `IFCELEMENT(${guid()},#5,'Abstract',$,$,$,$,$)`); } },
  { name: 'select-untyped-value', targets: 'invalid-type', apply: (r) => edit(r, 130, "IFCLABEL('REI90')", "'REI90'") },
  { name: 'typed-value-in-plain-slot', targets: 'invalid-type', apply: (r) => edit(r, 42, "'Wall A'", "IFCLABEL('Wall A')") },
  { name: 'header-author-not-list', targets: 'FILE_NAME.author', apply: () => ({ header: { ...DEFAULT_HEADER, name: "'corpus.ifc','2026-11-19T00:00:00','Jane Doe',('Example Org'),'ifc-lite','ifc-lite corpus',''" } }) },
];
