/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC class to Material Symbols icon code point mapping.
 * Based on https://github.com/AECgeeks/ifc-icons (MIT license).
 *
 * Values are Unicode code points for the Material Symbols Outlined font.
 */
export const IFC_ICON_CODEPOINTS: Record<string, string> = {
  // Spatial / context
  IfcContext: '\uf1c4',
  IfcProject: '\uf1c4',
  IfcProjectLibrary: '\uf1c4',
  IfcSite: '\ue80b',
  IfcBuilding: '\uea40',
  IfcBuildingStorey: '\ue8fe',
  IfcSpace: '\ueff4',
  // IFC4.3 facility containers \u2014 same family as IfcBuilding (multi-storey
  // spatial root) but `domain` carries the "campus / infrastructure
  // facility" reading; IfcFacilityPart follows the storey-line icon for
  // consistency. (Issue #860 \u2014 user reported no icon on IfcFacility.)
  IfcFacility: '\ue7ee', // "domain"
  IfcFacilityPart: '\ue8fe', // "layers" \u2014 mirrors IfcBuildingStorey
  IfcBridge: '\uebbf', // "directions_railway" \u2014 civil bridge icon
  IfcBridgePart: '\ue8fe',
  IfcRoad: '\uebbe', // "route"
  IfcRoadPart: '\ue8fe',
  IfcRailway: '\ue570', // "train"
  IfcRailwayPart: '\ue8fe',
  IfcMarineFacility: '\ue532', // "directions_boat"
  IfcMarineFacilityPart: '\ue8fe',

  // Structural
  IfcBeam: '\uf108',
  IfcBeamStandardCase: '\uf108',
  IfcColumn: '\ue233',
  IfcColumnStandardCase: '\ue233',
  IfcWall: '\ue3c0',
  IfcWallStandardCase: '\ue3c0',
  IfcWallElementedCase: '\ue3c0',
  IfcSlab: '\ue229',
  IfcSlabStandardCase: '\ue229',
  IfcSlabElementedCase: '\ue229',
  IfcRoof: '\uf201',
  IfcFooting: '\uf200',
  IfcPile: '\ue047',
  IfcPlate: '\ue047',
  IfcPlateStandardCase: '\ue047',
  IfcMember: '\ue047',
  IfcMemberStandardCase: '\ue047',

  // Openings & access
  IfcDoor: '\ueb4f',
  IfcDoorStandardCase: '\ueb4f',
  IfcWindow: '\uf088',
  IfcWindowStandardCase: '\uf088',
  IfcOpeningElement: '\ue3c6',
  IfcOpeningStandardCase: '\ue3c6',
  IfcCurtainWall: '\ue047',

  // Vertical circulation
  IfcStair: '\uf1a9',
  IfcStairFlight: '\uf1a9',
  IfcRamp: '\ue86b',
  IfcRampFlight: '\ue86b',
  IfcRailing: '\ue58f',

  // Furnishing
  IfcFurnishingElement: '\uea45',
  IfcFurniture: '\uea45',
  IfcSystemFurnitureElement: '\uea45',

  // MEP terminals
  IfcAirTerminal: '\uefd8',
  IfcLamp: '\uf02a',
  IfcLightFixture: '\uf02a',
  IfcSanitaryTerminal: '\uea41',
  IfcSpaceHeater: '\uf076',
  IfcAudioVisualAppliance: '\ue333',
  IfcSensor: '\ue51e',

  // Assemblies & misc
  IfcElementAssembly: '\ue9b0',
  IfcTransportElement: '\uf1a0',
  IfcGrid: '\uf015',
  IfcPort: '\ue8c0',
  IfcDistributionPort: '\ue8c0',
  IfcAnnotation: '\ue3c9',

  // Civil / geographic
  IfcCivilElement: '\uea99',
  IfcGeographicElement: '\uea99',
  IfcLinearElement: '\uebaa',

  // Geotechnical strata (IFC4.3) \u2014 issue #860. The abstract base plus the
  // three concrete leaves (IfcSolidStratum / IfcVoidStratum / IfcWaterStratum)
  // all share the `terrain` glyph. The geometry pipeline routes the leaves
  // through IfcGeotechnicalStratum via legacy_entities.rs, so the icon map
  // covers both the leaf names (when entries land in the spatial tree with
  // their original type string) and the base.
  IfcGeotechnicalAssembly: '\ue564',
  IfcGeotechnicalElement: '\ue564',
  IfcGeotechnicalStratum: '\ue564',
  IfcSolidStratum: '\ue564',
  IfcVoidStratum: '\ue564',
  IfcWaterStratum: '\ue564',

  // Proxy / generic fallback
  IfcProduct: '\ue047',
  IfcBuildingElementProxy: '\ue047',
  IfcProxy: '\ue047',
};

/** Default code point for unmapped IFC classes (Material Symbols "widgets" / generic product) */
export const IFC_ICON_DEFAULT = '\ue047';
