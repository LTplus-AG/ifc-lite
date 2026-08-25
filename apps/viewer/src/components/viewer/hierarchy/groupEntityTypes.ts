/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Concrete IfcGroup subtypes the Groups tab enumerates EXPLICITLY. The entity
 * index (`entityIndex.byType` / `getEntitiesByType`) is exact-match with no
 * subtype closure, so querying 'IfcSystem' alone would silently miss
 * IfcDistributionSystem / IfcBuiltSystem — exactly the classes MEP files use
 * (issue #1622; same defect class as #1662). This must list EVERY concrete
 * IfcGroup descendant in the supported schemas (IFC4 / IFC4X3) or those classes
 * never appear in the tab. Order = display order: systems, then zones, then
 * generic groups.
 */
export const GROUP_ENTITY_TYPES = [
  // IfcSystem family (bucketed under Systems).
  'IfcDistributionSystem',
  'IfcDistributionCircuit',
  // IFC2X3's spelling of a distribution circuit — the class IFC4 renamed to
  // IfcDistributionCircuit. `byType` is keyed by the raw STEP name, so without
  // it every electrical circuit in an IFC2X3 file contributes zero rows.
  'IfcElectricalCircuit',
  'IfcBuiltSystem',
  'IfcBuildingSystem',
  'IfcStructuralAnalysisModel',
  'IfcSystem',
  // IfcZone (its own bucket, though schema-wise a subtype of IfcSystem).
  'IfcZone',
  // Remaining concrete IfcGroup descendants (bucketed under Other).
  'IfcAsset',
  // IFC2X3-only, dropped in IFC4.
  'IfcCondition',
  'IfcInventory',
  'IfcStructuralLoadGroup',
  'IfcStructuralLoadCase',
  'IfcStructuralResultGroup',
  'IfcGroup',
] as const;

/** Sub-filter chips for the Groups tab (#1622). */
export type GroupSubFilter = 'all' | 'systems' | 'zones' | 'other';

const SYSTEM_GROUP_TYPES: ReadonlySet<string> = new Set([
  'IfcDistributionSystem',
  'IfcDistributionCircuit',
  'IfcElectricalCircuit',
  'IfcBuiltSystem',
  'IfcBuildingSystem',
  'IfcStructuralAnalysisModel',
  'IfcSystem',
]);

/** Whether a group entity class passes the Groups-tab sub-filter.
 *  Systems = the IfcSystem family (incl. IfcDistributionCircuit, its IFC2X3
 *  spelling IfcElectricalCircuit, and IfcStructuralAnalysisModel);
 *  Zones = IfcZone; Other = IfcGroup, IfcAsset, IfcCondition, IfcInventory,
 *  the structural load/result groups and any remaining class. */
export function groupMatchesSubFilter(ifcType: string, filter: GroupSubFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'systems': return SYSTEM_GROUP_TYPES.has(ifcType);
    case 'zones': return ifcType === 'IfcZone';
    case 'other': return !SYSTEM_GROUP_TYPES.has(ifcType) && ifcType !== 'IfcZone';
  }
}
