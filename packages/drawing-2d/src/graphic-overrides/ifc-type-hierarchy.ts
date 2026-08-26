/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC type hierarchy for graphic-override subtype matching.
 *
 * `ifcTypeCriterion` defaults `includeSubtypes` to true, so a rule naming a
 * supertype is expected to style every element beneath it. That expansion is
 * driven by the table below, which means anything the table omits is silently
 * skipped: the element still draws, just without the override the rule was
 * written to apply, and nothing warns.
 *
 * `SUBTYPES_BY_SUPERTYPE` is therefore mechanically derived from the IFC4
 * (ADD2 TC1) schema rather than curated by hand — it is the direct-children
 * map of every entity under `IfcElement` and `IfcSpatialElement`, the entities
 * a 2D drawing can contain. `ifc-type-hierarchy.test.ts` re-derives the same
 * map from `@ifc-lite/data`'s `ENTITIES_IFC4` and fails if the two disagree,
 * so a schema bump cannot quietly reintroduce the gap.
 *
 * Do not hand-edit `SUBTYPES_BY_SUPERTYPE` to add a convenience name; put it in
 * `AUTHORING_ALIASES` with a reason, or the parity test will reject it.
 */

/**
 * Direct subtypes of each entity, derived from IFC4 ADD2 TC1.
 * `getIfcSubtypes` walks this transitively.
 */
export const SUBTYPES_BY_SUPERTYPE: Readonly<Record<string, readonly string[]>> = {
  IfcBeam: ['IfcBeamStandardCase'],
  IfcBuildingElement: [
    'IfcBeam', 'IfcBuildingElementProxy', 'IfcChimney', 'IfcColumn', 'IfcCovering',
    'IfcCurtainWall', 'IfcDoor', 'IfcFooting', 'IfcMember', 'IfcPile', 'IfcPlate', 'IfcRailing',
    'IfcRamp', 'IfcRampFlight', 'IfcRoof', 'IfcShadingDevice', 'IfcSlab', 'IfcStair',
    'IfcStairFlight', 'IfcWall', 'IfcWindow',
  ],
  IfcColumn: ['IfcColumnStandardCase'],
  IfcDistributionControlElement: [
    'IfcActuator', 'IfcAlarm', 'IfcController', 'IfcFlowInstrument',
    'IfcProtectiveDeviceTrippingUnit', 'IfcSensor', 'IfcUnitaryControlElement',
  ],
  IfcDistributionElement: ['IfcDistributionControlElement', 'IfcDistributionFlowElement'],
  IfcDistributionFlowElement: [
    'IfcDistributionChamberElement', 'IfcEnergyConversionDevice', 'IfcFlowController',
    'IfcFlowFitting', 'IfcFlowMovingDevice', 'IfcFlowSegment', 'IfcFlowStorageDevice',
    'IfcFlowTerminal', 'IfcFlowTreatmentDevice',
  ],
  IfcDoor: ['IfcDoorStandardCase'],
  IfcElement: [
    'IfcBuildingElement', 'IfcCivilElement', 'IfcDistributionElement', 'IfcElementAssembly',
    'IfcElementComponent', 'IfcFeatureElement', 'IfcFurnishingElement', 'IfcGeographicElement',
    'IfcTransportElement', 'IfcVirtualElement',
  ],
  IfcElementComponent: [
    'IfcBuildingElementPart', 'IfcDiscreteAccessory', 'IfcFastener', 'IfcMechanicalFastener',
    'IfcReinforcingElement', 'IfcVibrationIsolator',
  ],
  IfcEnergyConversionDevice: [
    'IfcAirToAirHeatRecovery', 'IfcBoiler', 'IfcBurner', 'IfcChiller', 'IfcCoil',
    'IfcCondenser', 'IfcCooledBeam', 'IfcCoolingTower', 'IfcElectricGenerator',
    'IfcElectricMotor', 'IfcEngine', 'IfcEvaporativeCooler', 'IfcEvaporator',
    'IfcHeatExchanger', 'IfcHumidifier', 'IfcMotorConnection', 'IfcSolarDevice',
    'IfcTransformer', 'IfcTubeBundle', 'IfcUnitaryEquipment',
  ],
  IfcExternalSpatialStructureElement: ['IfcExternalSpatialElement'],
  IfcFeatureElement: [
    'IfcFeatureElementAddition', 'IfcFeatureElementSubtraction', 'IfcSurfaceFeature',
  ],
  IfcFeatureElementAddition: ['IfcProjectionElement'],
  IfcFeatureElementSubtraction: ['IfcOpeningElement', 'IfcVoidingFeature'],
  IfcFlowController: [
    'IfcAirTerminalBox', 'IfcDamper', 'IfcElectricDistributionBoard', 'IfcElectricTimeControl',
    'IfcFlowMeter', 'IfcProtectiveDevice', 'IfcSwitchingDevice', 'IfcValve',
  ],
  IfcFlowFitting: [
    'IfcCableCarrierFitting', 'IfcCableFitting', 'IfcDuctFitting', 'IfcJunctionBox',
    'IfcPipeFitting',
  ],
  IfcFlowMovingDevice: ['IfcCompressor', 'IfcFan', 'IfcPump'],
  IfcFlowSegment: ['IfcCableCarrierSegment', 'IfcCableSegment', 'IfcDuctSegment', 'IfcPipeSegment'],
  IfcFlowStorageDevice: ['IfcElectricFlowStorageDevice', 'IfcTank'],
  IfcFlowTerminal: [
    'IfcAirTerminal', 'IfcAudioVisualAppliance', 'IfcCommunicationsAppliance',
    'IfcElectricAppliance', 'IfcFireSuppressionTerminal', 'IfcLamp', 'IfcLightFixture',
    'IfcMedicalDevice', 'IfcOutlet', 'IfcSanitaryTerminal', 'IfcSpaceHeater',
    'IfcStackTerminal', 'IfcWasteTerminal',
  ],
  IfcFlowTreatmentDevice: ['IfcDuctSilencer', 'IfcFilter', 'IfcInterceptor'],
  IfcFurnishingElement: ['IfcFurniture', 'IfcSystemFurnitureElement'],
  IfcMember: ['IfcMemberStandardCase'],
  IfcOpeningElement: ['IfcOpeningStandardCase'],
  IfcPlate: ['IfcPlateStandardCase'],
  IfcReinforcingElement: [
    'IfcReinforcingBar', 'IfcReinforcingMesh', 'IfcTendon', 'IfcTendonAnchor',
  ],
  IfcSlab: ['IfcSlabElementedCase', 'IfcSlabStandardCase'],
  IfcSpatialElement: [
    'IfcExternalSpatialStructureElement', 'IfcSpatialStructureElement', 'IfcSpatialZone',
  ],
  IfcSpatialStructureElement: ['IfcBuilding', 'IfcBuildingStorey', 'IfcSite', 'IfcSpace'],
  IfcWall: ['IfcWallElementedCase', 'IfcWallStandardCase'],
  IfcWindow: ['IfcWindowStandardCase'],};

/**
 * Names that are NOT IFC4 entities but that rule authors reasonably write.
 * Kept deliberately, and separately, so the schema-parity test can hold
 * `SUBTYPES_BY_SUPERTYPE` to the schema exactly.
 */
export const AUTHORING_ALIASES: Readonly<Record<string, readonly string[]>> = {
  /**
   * Not an entity in IFC2X3, IFC4 or IFC4X3 — the real supertype of the flow
   * entities is `IfcDistributionFlowElement`. It shipped as a table key, so a
   * rule may already name it; mapping it keeps those rules working (and now
   * reaches the whole flow subtree rather than four names).
   */
  IfcFlowElement: ['IfcDistributionFlowElement'],
  /**
   * `IfcStairFlight`/`IfcRampFlight` are siblings of `IfcStair`/`IfcRamp` under
   * `IfcBuildingElement`, not subtypes. The table has always expanded them this
   * way and a rule on `IfcStair` that stopped covering its flights would be a
   * silent narrowing, so the authoring convenience is kept and named.
   */
  IfcStair: ['IfcStairFlight'],
  IfcRamp: ['IfcRampFlight'],
};

/** Schema subtypes plus authoring aliases, merged. */
const HIERARCHY: Record<string, readonly string[]> = (() => {
  const merged: Record<string, string[]> = {};
  for (const [parent, children] of Object.entries(SUBTYPES_BY_SUPERTYPE)) {
    merged[parent] = [...children];
  }
  for (const [parent, children] of Object.entries(AUTHORING_ALIASES)) {
    merged[parent] = [...new Set([...(merged[parent] ?? []), ...children])];
  }
  return merged;
})();

/**
 * Every transitive subtype of `ifcType`, or `[]` if it has none / is unknown.
 *
 * The returned names are unique. The walk tracks visited nodes, so an alias
 * that points back into the table cannot spin.
 */
export function getIfcSubtypes(ifcType: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (type: string): void => {
    for (const child of HIERARCHY[type] ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      walk(child);
    }
  };
  walk(ifcType);
  return out;
}
