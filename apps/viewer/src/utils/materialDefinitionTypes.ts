/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The concrete IFC classes an `IfcMaterialSelect` can resolve to — i.e. every
 * class that may legally be the `RelatingMaterial` of an `IfcRelAssociatesMaterial`.
 *
 * `IfcMaterialSelect = (IfcMaterialDefinition, IfcMaterialList,
 * IfcMaterialUsageDefinition)`; this set is the concrete (non-ABSTRACT) closure
 * of those three roots, identical in IFC4_ADD2_TC1 and IFC4X3, and a superset of
 * the IFC2X3 select. Names are upper-cased for direct comparison against raw
 * STEP class names.
 *
 * Single source of truth for two call sites that must agree — the Materials-tab
 * cache rebuild (`rebuildOnDemandMaps`, which decides what gets an association
 * edge) and the properties panel (which decides whether a selected entity gets
 * the material totals view). When they disagreed, the tab rendered rows the
 * panel then refused to recognise.
 *
 * Hand-listed rather than computed from `SCHEMA_REGISTRY` so the viewer bundle
 * does not have to carry the whole generated registry for thirteen names;
 * `materialDefinitionTypes.test.ts` derives the same set from the registry and
 * asserts equality in both directions, so drift fails CI instead of shipping.
 */
export const MATERIAL_DEF_TYPES: ReadonlySet<string> = new Set([
  // IfcMaterialDefinition subtree
  'IFCMATERIAL',
  'IFCMATERIALCONSTITUENT',
  'IFCMATERIALCONSTITUENTSET',
  'IFCMATERIALLAYER',
  'IFCMATERIALLAYERSET',
  'IFCMATERIALLAYERWITHOFFSETS',
  'IFCMATERIALPROFILE',
  'IFCMATERIALPROFILESET',
  'IFCMATERIALPROFILEWITHOFFSETS',
  // IfcMaterialUsageDefinition subtree
  'IFCMATERIALLAYERSETUSAGE',
  'IFCMATERIALPROFILESETUSAGE',
  'IFCMATERIALPROFILESETUSAGETAPERING',
  // IfcMaterialList
  'IFCMATERIALLIST',
]);

/** True when `rawType` is a STEP class name from {@link MATERIAL_DEF_TYPES}. */
export function isMaterialDefinitionType(rawType: string | null | undefined): boolean {
  return !!rawType && MATERIAL_DEF_TYPES.has(rawType.toUpperCase());
}
