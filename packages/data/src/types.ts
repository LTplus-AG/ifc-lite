/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Core types for columnar data structures
 */

export enum IfcTypeEnum {
  // Spatial structure
  IfcProject = 1,
  IfcSite = 2,
  IfcBuilding = 3,
  IfcBuildingStorey = 4,
  IfcSpace = 5,
  IfcFacility = 59,
  IfcFacilityPart = 60,
  IfcBridge = 61,
  IfcBridgePart = 62,
  IfcRoad = 63,
  IfcRoadPart = 64,
  IfcRailway = 65,
  IfcRailwayPart = 66,
  IfcMarineFacility = 67,

  // Building elements
  IfcWall = 10,
  IfcWallStandardCase = 11,
  IfcDoor = 12,
  IfcWindow = 13,
  IfcSlab = 14,
  IfcColumn = 15,
  IfcBeam = 16,
  IfcStair = 17,
  IfcRamp = 18,
  IfcRoof = 19,
  IfcCovering = 20,
  IfcCurtainWall = 21,
  IfcRailing = 22,
  IfcPile = 23,
  IfcMember = 24,
  IfcPlate = 25,
  IfcFooting = 26,
  IfcBuildingElementProxy = 27,
  IfcStairFlight = 28,
  IfcRampFlight = 29,
  IfcChimney = 31,
  IfcShadingDevice = 32,
  IfcBuildingElementPart = 33,

  // Openings
  IfcOpeningElement = 30,

  // Assemblies and structural
  IfcElementAssembly = 34,
  IfcReinforcingBar = 35,
  IfcReinforcingMesh = 36,
  IfcTendon = 37,
  IfcDiscreteAccessory = 38,
  IfcMechanicalFastener = 39,


  // MEP
  IfcDistributionElement = 40,
  IfcFlowTerminal = 41,
  IfcFlowSegment = 42,
  IfcFlowFitting = 43,
  IfcFlowController = 44,
  IfcFlowMovingDevice = 45,
  IfcFlowStorageDevice = 46,
  IfcFlowTreatmentDevice = 47,
  IfcEnergyConversionDevice = 48,
  IfcDuctSegment = 49,
  IfcPipeSegment = 50,
  IfcCableSegment = 51,

  // Furnishing
  IfcFurnishingElement = 52,
  IfcFurniture = 53,

  // Other product types
  IfcProxy = 54,
  IfcAnnotation = 55,
  IfcTransportElement = 56,
  IfcCivilElement = 57,
  IfcGeographicElement = 58,

  // Relationships
  IfcRelContainedInSpatialStructure = 100,
  IfcRelAggregates = 101,
  IfcRelDefinesByProperties = 102,
  IfcRelDefinesByType = 103,
  IfcRelAssociatesMaterial = 104,
  IfcRelAssociatesClassification = 105,
  IfcRelVoidsElement = 106,
  IfcRelFillsElement = 107,
  IfcRelConnectsPathElements = 108,
  IfcRelSpaceBoundary = 109,

  // Property definitions
  IfcPropertySet = 200,
  IfcPropertySingleValue = 201,
  IfcPropertyEnumeratedValue = 202,
  IfcPropertyBoundedValue = 203,
  IfcPropertyListValue = 204,
  IfcElementQuantity = 210,
  IfcQuantityLength = 211,
  IfcQuantityArea = 212,
  IfcQuantityVolume = 213,
  IfcQuantityCount = 214,
  IfcQuantityWeight = 215,

  // Types
  IfcWallType = 300,
  IfcDoorType = 301,
  IfcWindowType = 302,
  IfcSlabType = 303,
  IfcColumnType = 304,
  IfcBeamType = 305,
  IfcPileType = 306,
  IfcMemberType = 307,
  IfcPlateType = 308,
  IfcFootingType = 309,
  IfcCoveringType = 310,
  IfcRailingType = 311,
  IfcStairType = 312,
  IfcRampType = 313,
  IfcRoofType = 314,
  IfcCurtainWallType = 315,
  IfcBuildingElementProxyType = 316,

  Unknown = 9999,
}

export enum PropertyValueType {
  String = 0,
  Real = 1,
  Integer = 2,
  Boolean = 3,
  Logical = 4,
  Label = 5,
  Identifier = 6,
  Text = 7,
  Enum = 8,
  Reference = 9,
  List = 10,
}

export enum QuantityType {
  Length = 0,
  Area = 1,
  Volume = 2,
  Count = 3,
  Weight = 4,
  Time = 5,
}

export enum RelationshipType {
  ContainsElements = 1,
  Aggregates = 2,
  DefinesByProperties = 10,
  DefinesByType = 11,
  AssociatesMaterial = 20,
  AssociatesClassification = 30,
  AssociatesDocument = 31,
  ConnectsPathElements = 40,
  FillsElement = 41,
  VoidsElement = 42,
  ConnectsElements = 43,
  ConnectsStructuralMember = 44,
  ConnectsWithRealizingElements = 45,
  SpaceBoundary = 50,
  AssignsToGroup = 60,
  AssignsToProduct = 61,
  ReferencedInSpatialStructure = 70,
}

export enum EntityFlags {
  HAS_GEOMETRY = 0b00000001,
  HAS_PROPERTIES = 0b00000010,
  HAS_QUANTITIES = 0b00000100,
  IS_TYPE = 0b00001000,
  IS_EXTERNAL = 0b00010000,
  HAS_OPENINGS = 0b00100000,
  IS_FILLING = 0b01000000,
}

export interface SpatialNode {
  expressId: number;
  type: IfcTypeEnum;
  name: string;
  elevation?: number;
  children: SpatialNode[];
  elements: number[];  // Direct contained elements
}

export interface SpatialHierarchy {
  project: SpatialNode;
  byStorey: Map<number, number[]>;    // storeyId -> element IDs
  byBuilding: Map<number, number[]>;  // buildingId -> element IDs
  bySite: Map<number, number[]>;      // siteId -> element IDs
  bySpace: Map<number, number[]>;     // spaceId -> element IDs
  storeyElevations: Map<number, number>;  // storeyId -> elevation (z)
  storeyHeights: Map<number, number>;     // storeyId -> floor-to-floor height (calculated from elevation differences)
  elementToStorey: Map<number, number>;  // elementId -> storeyId (reverse lookup)
  
  // Helper methods
  getStoreyElements(storeyId: number): number[];
  getStoreyByElevation(z: number): number | null;
  getContainingSpace(elementId: number): number | null;
  getPath(elementId: number): SpatialNode[]; // Project → ... → Element
}

// Type conversion helpers
const TYPE_STRING_TO_ENUM = new Map<string, IfcTypeEnum>([
  // Spatial
  ['IFCPROJECT', IfcTypeEnum.IfcProject],
  ['IFCSITE', IfcTypeEnum.IfcSite],
  ['IFCBUILDING', IfcTypeEnum.IfcBuilding],
  ['IFCBUILDINGSTOREY', IfcTypeEnum.IfcBuildingStorey],
  ['IFCSPACE', IfcTypeEnum.IfcSpace],
  ['IFCFACILITY', IfcTypeEnum.IfcFacility],
  ['IFCFACILITYPART', IfcTypeEnum.IfcFacilityPart],
  ['IFCBRIDGE', IfcTypeEnum.IfcBridge],
  ['IFCBRIDGEPART', IfcTypeEnum.IfcBridgePart],
  ['IFCROAD', IfcTypeEnum.IfcRoad],
  ['IFCROADPART', IfcTypeEnum.IfcRoadPart],
  ['IFCRAILWAY', IfcTypeEnum.IfcRailway],
  ['IFCRAILWAYPART', IfcTypeEnum.IfcRailwayPart],
  ['IFCMARINEFACILITY', IfcTypeEnum.IfcMarineFacility],
  // Building elements
  ['IFCWALL', IfcTypeEnum.IfcWall],
  ['IFCWALLSTANDARDCASE', IfcTypeEnum.IfcWallStandardCase],
  ['IFCDOOR', IfcTypeEnum.IfcDoor],
  ['IFCDOORSTANDARDCASE', IfcTypeEnum.IfcDoor],
  ['IFCWINDOW', IfcTypeEnum.IfcWindow],
  ['IFCWINDOWSTANDARDCASE', IfcTypeEnum.IfcWindow],
  ['IFCSLAB', IfcTypeEnum.IfcSlab],
  ['IFCSLABSTANDARDCASE', IfcTypeEnum.IfcSlab],
  ['IFCCOLUMN', IfcTypeEnum.IfcColumn],
  ['IFCCOLUMNSTANDARDCASE', IfcTypeEnum.IfcColumn],
  ['IFCBEAM', IfcTypeEnum.IfcBeam],
  ['IFCBEAMSTANDARDCASE', IfcTypeEnum.IfcBeam],
  ['IFCSTAIR', IfcTypeEnum.IfcStair],
  ['IFCSTAIRFLIGHT', IfcTypeEnum.IfcStairFlight],
  ['IFCRAMP', IfcTypeEnum.IfcRamp],
  ['IFCRAMPFLIGHT', IfcTypeEnum.IfcRampFlight],
  ['IFCROOF', IfcTypeEnum.IfcRoof],
  ['IFCCOVERING', IfcTypeEnum.IfcCovering],
  ['IFCCURTAINWALL', IfcTypeEnum.IfcCurtainWall],
  ['IFCRAILING', IfcTypeEnum.IfcRailing],
  ['IFCPILE', IfcTypeEnum.IfcPile],
  ['IFCMEMBER', IfcTypeEnum.IfcMember],
  ['IFCMEMBERSTANDARDCASE', IfcTypeEnum.IfcMember],
  ['IFCPLATE', IfcTypeEnum.IfcPlate],
  ['IFCPLATESTANDARDCASE', IfcTypeEnum.IfcPlate],
  ['IFCFOOTING', IfcTypeEnum.IfcFooting],
  ['IFCBUILDINGELEMENTPROXY', IfcTypeEnum.IfcBuildingElementProxy],
  ['IFCCHIMNEY', IfcTypeEnum.IfcChimney],
  ['IFCSHADINGDEVICE', IfcTypeEnum.IfcShadingDevice],
  ['IFCBUILDINGELEMENTPART', IfcTypeEnum.IfcBuildingElementPart],
  // Openings
  ['IFCOPENINGELEMENT', IfcTypeEnum.IfcOpeningElement],
  ['IFCOPENINGSTANDARDCASE', IfcTypeEnum.IfcOpeningElement],
  // Assemblies and structural
  ['IFCELEMENTASSEMBLY', IfcTypeEnum.IfcElementAssembly],
  ['IFCREINFORCINGBAR', IfcTypeEnum.IfcReinforcingBar],
  ['IFCREINFORCINGMESH', IfcTypeEnum.IfcReinforcingMesh],
  ['IFCTENDON', IfcTypeEnum.IfcTendon],
  ['IFCTENDONANCHOR', IfcTypeEnum.IfcTendon],
  ['IFCDISCRETEACCESSORY', IfcTypeEnum.IfcDiscreteAccessory],
  ['IFCMECHANICALFASTENER', IfcTypeEnum.IfcMechanicalFastener],
  ['IFCFASTENER', IfcTypeEnum.IfcMechanicalFastener],
  // MEP
  ['IFCDISTRIBUTIONELEMENT', IfcTypeEnum.IfcDistributionElement],
  ['IFCDISTRIBUTIONFLOWELEMENT', IfcTypeEnum.IfcDistributionElement],
  ['IFCDISTRIBUTIONCONTROLELEMENT', IfcTypeEnum.IfcDistributionElement],
  ['IFCFLOWTERMINAL', IfcTypeEnum.IfcFlowTerminal],
  ['IFCFLOWSEGMENT', IfcTypeEnum.IfcFlowSegment],
  ['IFCFLOWFITTING', IfcTypeEnum.IfcFlowFitting],
  ['IFCFLOWCONTROLLER', IfcTypeEnum.IfcFlowController],
  ['IFCFLOWMOVINGDEVICE', IfcTypeEnum.IfcFlowMovingDevice],
  ['IFCFLOWSTORAGEDEVICE', IfcTypeEnum.IfcFlowStorageDevice],
  ['IFCFLOWTREATMENTDEVICE', IfcTypeEnum.IfcFlowTreatmentDevice],
  ['IFCENERGYCONVERSIONDEVICE', IfcTypeEnum.IfcEnergyConversionDevice],
  ['IFCDUCTSEGMENT', IfcTypeEnum.IfcDuctSegment],
  ['IFCPIPESEGMENT', IfcTypeEnum.IfcPipeSegment],
  ['IFCCABLESEGMENT', IfcTypeEnum.IfcCableSegment],
  ['IFCCABLECARRIERSEGMENT', IfcTypeEnum.IfcCableSegment],
  // Furnishing
  ['IFCFURNISHINGELEMENT', IfcTypeEnum.IfcFurnishingElement],
  ['IFCFURNITURE', IfcTypeEnum.IfcFurniture],
  // Other products
  ['IFCPROXY', IfcTypeEnum.IfcProxy],
  ['IFCANNOTATION', IfcTypeEnum.IfcAnnotation],
  ['IFCTRANSPORTELEMENT', IfcTypeEnum.IfcTransportElement],
  ['IFCCIVILELEMENT', IfcTypeEnum.IfcCivilElement],
  ['IFCGEOGRAPHICELEMENT', IfcTypeEnum.IfcGeographicElement],
  // Relationships
  ['IFCRELCONTAINEDINSPATIALSTRUCTURE', IfcTypeEnum.IfcRelContainedInSpatialStructure],
  ['IFCRELAGGREGATES', IfcTypeEnum.IfcRelAggregates],
  ['IFCRELDEFINESBYPROPERTIES', IfcTypeEnum.IfcRelDefinesByProperties],
  ['IFCRELDEFINESBYTYPE', IfcTypeEnum.IfcRelDefinesByType],
  ['IFCRELASSOCIATESMATERIAL', IfcTypeEnum.IfcRelAssociatesMaterial],
  ['IFCRELASSOCIATESCLASSIFICATION', IfcTypeEnum.IfcRelAssociatesClassification],
  ['IFCRELVOIDSELEMENT', IfcTypeEnum.IfcRelVoidsElement],
  ['IFCRELFILLSELEMENT', IfcTypeEnum.IfcRelFillsElement],
  ['IFCRELCONNECTSPATHELEMENTS', IfcTypeEnum.IfcRelConnectsPathElements],
  ['IFCRELSPACEBOUNDARY', IfcTypeEnum.IfcRelSpaceBoundary],
  // Properties
  ['IFCPROPERTYSET', IfcTypeEnum.IfcPropertySet],
  ['IFCPROPERTYSINGLEVALUE', IfcTypeEnum.IfcPropertySingleValue],
  ['IFCPROPERTYENUMERATEDVALUE', IfcTypeEnum.IfcPropertyEnumeratedValue],
  ['IFCPROPERTYBOUNDEDVALUE', IfcTypeEnum.IfcPropertyBoundedValue],
  ['IFCPROPERTYLISTVALUE', IfcTypeEnum.IfcPropertyListValue],
  ['IFCELEMENTQUANTITY', IfcTypeEnum.IfcElementQuantity],
  ['IFCQUANTITYLENGTH', IfcTypeEnum.IfcQuantityLength],
  ['IFCQUANTITYAREA', IfcTypeEnum.IfcQuantityArea],
  ['IFCQUANTITYVOLUME', IfcTypeEnum.IfcQuantityVolume],
  ['IFCQUANTITYCOUNT', IfcTypeEnum.IfcQuantityCount],
  ['IFCQUANTITYWEIGHT', IfcTypeEnum.IfcQuantityWeight],
  // Type definitions
  ['IFCWALLTYPE', IfcTypeEnum.IfcWallType],
  ['IFCDOORTYPE', IfcTypeEnum.IfcDoorType],
  ['IFCWINDOWTYPE', IfcTypeEnum.IfcWindowType],
  ['IFCSLABTYPE', IfcTypeEnum.IfcSlabType],
  ['IFCCOLUMNTYPE', IfcTypeEnum.IfcColumnType],
  ['IFCBEAMTYPE', IfcTypeEnum.IfcBeamType],
  ['IFCPILETYPE', IfcTypeEnum.IfcPileType],
  ['IFCMEMBERTYPE', IfcTypeEnum.IfcMemberType],
  ['IFCPLATETYPE', IfcTypeEnum.IfcPlateType],
  ['IFCFOOTINGTYPE', IfcTypeEnum.IfcFootingType],
  ['IFCCOVERINGTYPE', IfcTypeEnum.IfcCoveringType],
  ['IFCRAILINGTYPE', IfcTypeEnum.IfcRailingType],
  ['IFCSTAIRTYPE', IfcTypeEnum.IfcStairType],
  ['IFCRAMPTYPE', IfcTypeEnum.IfcRampType],
  ['IFCROOFTYPE', IfcTypeEnum.IfcRoofType],
  ['IFCCURTAINWALLTYPE', IfcTypeEnum.IfcCurtainWallType],
  ['IFCBUILDINGELEMENTPROXYTYPE', IfcTypeEnum.IfcBuildingElementProxyType],
]);

const TYPE_ENUM_TO_STRING = new Map<IfcTypeEnum, string>([
  // Spatial
  [IfcTypeEnum.IfcProject, 'IfcProject'],
  [IfcTypeEnum.IfcSite, 'IfcSite'],
  [IfcTypeEnum.IfcBuilding, 'IfcBuilding'],
  [IfcTypeEnum.IfcBuildingStorey, 'IfcBuildingStorey'],
  [IfcTypeEnum.IfcSpace, 'IfcSpace'],
  [IfcTypeEnum.IfcFacility, 'IfcFacility'],
  [IfcTypeEnum.IfcFacilityPart, 'IfcFacilityPart'],
  [IfcTypeEnum.IfcBridge, 'IfcBridge'],
  [IfcTypeEnum.IfcBridgePart, 'IfcBridgePart'],
  [IfcTypeEnum.IfcRoad, 'IfcRoad'],
  [IfcTypeEnum.IfcRoadPart, 'IfcRoadPart'],
  [IfcTypeEnum.IfcRailway, 'IfcRailway'],
  [IfcTypeEnum.IfcRailwayPart, 'IfcRailwayPart'],
  [IfcTypeEnum.IfcMarineFacility, 'IfcMarineFacility'],
  // Building elements
  [IfcTypeEnum.IfcWall, 'IfcWall'],
  [IfcTypeEnum.IfcWallStandardCase, 'IfcWallStandardCase'],
  [IfcTypeEnum.IfcDoor, 'IfcDoor'],
  [IfcTypeEnum.IfcWindow, 'IfcWindow'],
  [IfcTypeEnum.IfcSlab, 'IfcSlab'],
  [IfcTypeEnum.IfcColumn, 'IfcColumn'],
  [IfcTypeEnum.IfcBeam, 'IfcBeam'],
  [IfcTypeEnum.IfcStair, 'IfcStair'],
  [IfcTypeEnum.IfcStairFlight, 'IfcStairFlight'],
  [IfcTypeEnum.IfcRamp, 'IfcRamp'],
  [IfcTypeEnum.IfcRampFlight, 'IfcRampFlight'],
  [IfcTypeEnum.IfcRoof, 'IfcRoof'],
  [IfcTypeEnum.IfcCovering, 'IfcCovering'],
  [IfcTypeEnum.IfcCurtainWall, 'IfcCurtainWall'],
  [IfcTypeEnum.IfcRailing, 'IfcRailing'],
  [IfcTypeEnum.IfcPile, 'IfcPile'],
  [IfcTypeEnum.IfcMember, 'IfcMember'],
  [IfcTypeEnum.IfcPlate, 'IfcPlate'],
  [IfcTypeEnum.IfcFooting, 'IfcFooting'],
  [IfcTypeEnum.IfcBuildingElementProxy, 'IfcBuildingElementProxy'],
  [IfcTypeEnum.IfcChimney, 'IfcChimney'],
  [IfcTypeEnum.IfcShadingDevice, 'IfcShadingDevice'],
  [IfcTypeEnum.IfcBuildingElementPart, 'IfcBuildingElementPart'],
  // Openings
  [IfcTypeEnum.IfcOpeningElement, 'IfcOpeningElement'],
  // Assemblies and structural
  [IfcTypeEnum.IfcElementAssembly, 'IfcElementAssembly'],
  [IfcTypeEnum.IfcReinforcingBar, 'IfcReinforcingBar'],
  [IfcTypeEnum.IfcReinforcingMesh, 'IfcReinforcingMesh'],
  [IfcTypeEnum.IfcTendon, 'IfcTendon'],
  [IfcTypeEnum.IfcDiscreteAccessory, 'IfcDiscreteAccessory'],
  [IfcTypeEnum.IfcMechanicalFastener, 'IfcMechanicalFastener'],
  // MEP
  [IfcTypeEnum.IfcDistributionElement, 'IfcDistributionElement'],
  [IfcTypeEnum.IfcFlowTerminal, 'IfcFlowTerminal'],
  [IfcTypeEnum.IfcFlowSegment, 'IfcFlowSegment'],
  [IfcTypeEnum.IfcFlowFitting, 'IfcFlowFitting'],
  [IfcTypeEnum.IfcFlowController, 'IfcFlowController'],
  [IfcTypeEnum.IfcFlowMovingDevice, 'IfcFlowMovingDevice'],
  [IfcTypeEnum.IfcFlowStorageDevice, 'IfcFlowStorageDevice'],
  [IfcTypeEnum.IfcFlowTreatmentDevice, 'IfcFlowTreatmentDevice'],
  [IfcTypeEnum.IfcEnergyConversionDevice, 'IfcEnergyConversionDevice'],
  [IfcTypeEnum.IfcDuctSegment, 'IfcDuctSegment'],
  [IfcTypeEnum.IfcPipeSegment, 'IfcPipeSegment'],
  [IfcTypeEnum.IfcCableSegment, 'IfcCableSegment'],
  // Furnishing
  [IfcTypeEnum.IfcFurnishingElement, 'IfcFurnishingElement'],
  [IfcTypeEnum.IfcFurniture, 'IfcFurniture'],
  // Other products
  [IfcTypeEnum.IfcProxy, 'IfcProxy'],
  [IfcTypeEnum.IfcAnnotation, 'IfcAnnotation'],
  [IfcTypeEnum.IfcTransportElement, 'IfcTransportElement'],
  [IfcTypeEnum.IfcCivilElement, 'IfcCivilElement'],
  [IfcTypeEnum.IfcGeographicElement, 'IfcGeographicElement'],
  // Relationships
  [IfcTypeEnum.IfcRelContainedInSpatialStructure, 'IfcRelContainedInSpatialStructure'],
  [IfcTypeEnum.IfcRelAggregates, 'IfcRelAggregates'],
  [IfcTypeEnum.IfcRelDefinesByProperties, 'IfcRelDefinesByProperties'],
  [IfcTypeEnum.IfcRelDefinesByType, 'IfcRelDefinesByType'],
  [IfcTypeEnum.IfcRelAssociatesMaterial, 'IfcRelAssociatesMaterial'],
  [IfcTypeEnum.IfcRelAssociatesClassification, 'IfcRelAssociatesClassification'],
  [IfcTypeEnum.IfcRelVoidsElement, 'IfcRelVoidsElement'],
  [IfcTypeEnum.IfcRelFillsElement, 'IfcRelFillsElement'],
  [IfcTypeEnum.IfcRelConnectsPathElements, 'IfcRelConnectsPathElements'],
  [IfcTypeEnum.IfcRelSpaceBoundary, 'IfcRelSpaceBoundary'],
  // Properties
  [IfcTypeEnum.IfcPropertySet, 'IfcPropertySet'],
  [IfcTypeEnum.IfcPropertySingleValue, 'IfcPropertySingleValue'],
  [IfcTypeEnum.IfcPropertyEnumeratedValue, 'IfcPropertyEnumeratedValue'],
  [IfcTypeEnum.IfcPropertyBoundedValue, 'IfcPropertyBoundedValue'],
  [IfcTypeEnum.IfcPropertyListValue, 'IfcPropertyListValue'],
  [IfcTypeEnum.IfcElementQuantity, 'IfcElementQuantity'],
  [IfcTypeEnum.IfcQuantityLength, 'IfcQuantityLength'],
  [IfcTypeEnum.IfcQuantityArea, 'IfcQuantityArea'],
  [IfcTypeEnum.IfcQuantityVolume, 'IfcQuantityVolume'],
  [IfcTypeEnum.IfcQuantityCount, 'IfcQuantityCount'],
  [IfcTypeEnum.IfcQuantityWeight, 'IfcQuantityWeight'],
  // Type definitions
  [IfcTypeEnum.IfcWallType, 'IfcWallType'],
  [IfcTypeEnum.IfcDoorType, 'IfcDoorType'],
  [IfcTypeEnum.IfcWindowType, 'IfcWindowType'],
  [IfcTypeEnum.IfcSlabType, 'IfcSlabType'],
  [IfcTypeEnum.IfcColumnType, 'IfcColumnType'],
  [IfcTypeEnum.IfcBeamType, 'IfcBeamType'],
  [IfcTypeEnum.IfcPileType, 'IfcPileType'],
  [IfcTypeEnum.IfcMemberType, 'IfcMemberType'],
  [IfcTypeEnum.IfcPlateType, 'IfcPlateType'],
  [IfcTypeEnum.IfcFootingType, 'IfcFootingType'],
  [IfcTypeEnum.IfcCoveringType, 'IfcCoveringType'],
  [IfcTypeEnum.IfcRailingType, 'IfcRailingType'],
  [IfcTypeEnum.IfcStairType, 'IfcStairType'],
  [IfcTypeEnum.IfcRampType, 'IfcRampType'],
  [IfcTypeEnum.IfcRoofType, 'IfcRoofType'],
  [IfcTypeEnum.IfcCurtainWallType, 'IfcCurtainWallType'],
  [IfcTypeEnum.IfcBuildingElementProxyType, 'IfcBuildingElementProxyType'],
]);

export function IfcTypeEnumFromString(str: string): IfcTypeEnum {
  return TYPE_STRING_TO_ENUM.get(str.toUpperCase()) ?? IfcTypeEnum.Unknown;
}

export function IfcTypeEnumToString(type: IfcTypeEnum): string {
  return TYPE_ENUM_TO_STRING.get(type) ?? 'Unknown';
}
