/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Core types for columnar data structures */

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
  // The two remaining concrete IfcFacilityPart subtypes. IfcMarinePart is the
  // part of an IfcMarineFacility (berth, quay, approach channel) and
  // IfcFacilityPartCommon the part of a generic IfcFacility — the exact
  // counterparts of IfcBridgePart / IfcRoadPart / IfcRailwayPart above, which
  // were listed while these two were not. Ids continue the #1075 block above
  // the platform-variant max rather than filling the 68/69 gap, for the reason
  // spelled out on IfcSpatialZone below.
  IfcMarinePart = 321,
  IfcFacilityPartCommon = 322,
  // IfcSpatialZone is a spatial structure element (modelled GFA volumes);
  // IfcZone is a grouping (IfcSystem) of spaces/zones. Ids are above the
  // current max to avoid colliding with platform-variant func_elem indices
  // stripped by the wasm-free typecheck lane (#1002) — added for #1075.
  IfcSpatialZone = 317,
  IfcZone = 318,
  // IfcSystem / IfcDistributionSystem are IfcGroup-family groupings (MEP
  // systems, distribution networks). Listed/coloured by membership like
  // IfcZone. Ids continue the #1075 block above the platform-variant max.
  IfcSystem = 319,
  IfcDistributionSystem = 320,

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

  // IFC4x3 infrastructure leaves (issue with AB22.ifc, the railway fixture,
  // and any other infrastructure model — pre-fix every IfcCourse / IfcPavement
  // / IfcSignal / IfcReferent showed up as "Unknown" in the properties panel
  // even though the Rust geometry pipeline correctly identified the type).
  IfcCourse = 70,
  IfcPavement = 71,
  IfcKerb = 72,
  IfcMooringDevice = 73,
  IfcNavigationElement = 74,
  IfcTrackElement = 75,
  IfcVehicle = 76,
  IfcEarthworksElement = 77,
  IfcEarthworksFill = 78,
  IfcEarthworksCut = 79,
  IfcReferent = 80,
  IfcSign = 81,
  IfcSignal = 82,
  IfcGeotechnicalStratum = 83,
  IfcGeotechnicalAssembly = 84,
  IfcSolidStratum = 85,
  IfcVoidStratum = 86,
  IfcWaterStratum = 87,
  IfcPositioningElement = 88,
  IfcAlignment = 89,

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
  /** `IfcQuantityNumber` — a dimensionless count-like value, IFC4X3+ only. */
  Number = 6,
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
  /**
   * `IfcRelConnectsPortToElement` — a port belongs to the element it sits on.
   * Forward runs port → element, matching the EXPRESS attribute order
   * (RelatingPort, RelatedElement).
   */
  ConnectsPortToElement = 44,
  /**
   * `IfcRelConnectsPorts` — one port joined to another. Together with
   * {@link ConnectsPortToElement} this is what makes plant topology
   * traversable: element → its ports → the ports they connect to → those
   * ports' elements. Without both, a distribution system in a model is a set
   * of unrelated parts.
   */
  ConnectsPorts = 45,
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
  /** IFC `LongName` (the descriptive name), when present and distinct from
   *  `name`. Spatial structure elements often carry an ISO 19650 code in `Name`
   *  ("01") and the human label in `LongName` ("Main Residence"); the hierarchy
   *  panel shows both (issue #1634). Undefined when the entity declares no
   *  LongName or it duplicates `name`. */
  longName?: string;
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
  /**
   * elementId -> the nearest spatial container node that ultimately contains
   * it, at ANY level (storey, IfcSpace / IfcSpatialZone, or an infrastructure
   * IfcBridgePart / IfcRoadPart / …). Unlike `elementToStorey` (storey-only),
   * this also records aggregated descendants of a directly-contained element
   * (e.g. an IfcBeam aggregated into an IfcElementAssembly that is contained in
   * an IfcBridgePart), so the "immediate Container" lookup resolves under
   * non-storey containers too. Optional: legacy / non-parser hierarchies that
   * predate it fall back to `elementToStorey`.
   */
  elementToContainer?: Map<number, number>;

  // Helper methods
  getStoreyElements(storeyId: number): number[];
  getStoreyByElevation(z: number): number | null;
  getContainingSpace(elementId: number): number | null;
  getPath(elementId: number): SpatialNode[]; // Project → ... → Element
}

// Type conversion helpers. A row may coalesce onto an ANCESTOR
// (IFCDOORSTANDARDCASE -> IfcDoor) but never a sibling or child, which renames
// the element to a different IFC class; `type-enum-ancestry.test.ts` sweeps it.
const TYPE_STRING_TO_ENUM = new Map<string, IfcTypeEnum>([
  // Spatial
  ['IFCPROJECT', IfcTypeEnum.IfcProject],
  ['IFCSITE', IfcTypeEnum.IfcSite],
  ['IFCBUILDING', IfcTypeEnum.IfcBuilding],
  ['IFCBUILDINGSTOREY', IfcTypeEnum.IfcBuildingStorey],
  ['IFCSPACE', IfcTypeEnum.IfcSpace],
  ['IFCSPATIALZONE', IfcTypeEnum.IfcSpatialZone],
  ['IFCZONE', IfcTypeEnum.IfcZone],
  ['IFCSYSTEM', IfcTypeEnum.IfcSystem],
  ['IFCDISTRIBUTIONSYSTEM', IfcTypeEnum.IfcDistributionSystem],
  ['IFCFACILITY', IfcTypeEnum.IfcFacility],
  ['IFCFACILITYPART', IfcTypeEnum.IfcFacilityPart],
  ['IFCBRIDGE', IfcTypeEnum.IfcBridge],
  ['IFCBRIDGEPART', IfcTypeEnum.IfcBridgePart],
  ['IFCROAD', IfcTypeEnum.IfcRoad],
  ['IFCROADPART', IfcTypeEnum.IfcRoadPart],
  ['IFCRAILWAY', IfcTypeEnum.IfcRailway],
  ['IFCRAILWAYPART', IfcTypeEnum.IfcRailwayPart],
  ['IFCMARINEFACILITY', IfcTypeEnum.IfcMarineFacility],
  ['IFCMARINEPART', IfcTypeEnum.IfcMarinePart],
  ['IFCFACILITYPARTCOMMON', IfcTypeEnum.IfcFacilityPartCommon],
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
  ['IFCDISCRETEACCESSORY', IfcTypeEnum.IfcDiscreteAccessory],
  ['IFCMECHANICALFASTENER', IfcTypeEnum.IfcMechanicalFastener],
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
  // Furnishing
  ['IFCFURNISHINGELEMENT', IfcTypeEnum.IfcFurnishingElement],
  ['IFCFURNITURE', IfcTypeEnum.IfcFurniture],
  // Other products
  ['IFCPROXY', IfcTypeEnum.IfcProxy],
  ['IFCANNOTATION', IfcTypeEnum.IfcAnnotation],
  ['IFCTRANSPORTELEMENT', IfcTypeEnum.IfcTransportElement],
  ['IFCCIVILELEMENT', IfcTypeEnum.IfcCivilElement],
  ['IFCGEOGRAPHICELEMENT', IfcTypeEnum.IfcGeographicElement],
  // IFC4x3 infrastructure leaves
  ['IFCCOURSE', IfcTypeEnum.IfcCourse],
  ['IFCPAVEMENT', IfcTypeEnum.IfcPavement],
  ['IFCKERB', IfcTypeEnum.IfcKerb],
  ['IFCMOORINGDEVICE', IfcTypeEnum.IfcMooringDevice],
  ['IFCNAVIGATIONELEMENT', IfcTypeEnum.IfcNavigationElement],
  ['IFCTRACKELEMENT', IfcTypeEnum.IfcTrackElement],
  ['IFCVEHICLE', IfcTypeEnum.IfcVehicle],
  ['IFCEARTHWORKSELEMENT', IfcTypeEnum.IfcEarthworksElement],
  ['IFCEARTHWORKSFILL', IfcTypeEnum.IfcEarthworksFill],
  ['IFCEARTHWORKSCUT', IfcTypeEnum.IfcEarthworksCut],
  ['IFCREFERENT', IfcTypeEnum.IfcReferent],
  ['IFCSIGN', IfcTypeEnum.IfcSign],
  ['IFCSIGNAL', IfcTypeEnum.IfcSignal],
  ['IFCGEOTECHNICALSTRATUM', IfcTypeEnum.IfcGeotechnicalStratum],
  ['IFCGEOTECHNICALASSEMBLY', IfcTypeEnum.IfcGeotechnicalAssembly],
  ['IFCSOLIDSTRATUM', IfcTypeEnum.IfcSolidStratum],
  ['IFCVOIDSTRATUM', IfcTypeEnum.IfcVoidStratum],
  ['IFCWATERSTRATUM', IfcTypeEnum.IfcWaterStratum],
  ['IFCPOSITIONINGELEMENT', IfcTypeEnum.IfcPositioningElement],
  ['IFCALIGNMENT', IfcTypeEnum.IfcAlignment],
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


export function IfcTypeEnumFromString(str: string): IfcTypeEnum {
  return TYPE_STRING_TO_ENUM.get(str.toUpperCase()) ?? IfcTypeEnum.Unknown;
}

export function IfcTypeEnumToString(type: IfcTypeEnum): string {
  // TypeScript's reverse mapping on a numeric enum: `IfcTypeEnum[67]` is the
  // MEMBER NAME, 'IfcMarineFacility'. Every member name in this enum already
  // spells the IFC class exactly, so a hand-written enum->string table would
  // be a second copy of the member list with nothing keeping the two in step
  // — the drift that puts a class in one direction and not the other. An id
  // no member holds reverse-maps to undefined, which is the same 'Unknown'
  // the table's `.get()` miss produced.
  return IfcTypeEnum[type] ?? 'Unknown';
}

/**
 * IFC STEP attribute value as extracted from a STEP argument list.
 *
 * Two WRITE-ONLY markers (never produced by extraction) let authoring code
 * pin the exact STEP token for a value whose type a bare JS primitive cannot
 * convey:
 *
 * - `{ real: number }` forces a STEP REAL literal with a decimal point for
 *   whole numbers (`5.` not `5`), which typed measures like `IfcLengthMeasure`
 *   require. Plain `number` keeps the historical integer-when-whole behavior.
 *
 * - `{ typed: { type, value } }` forces a type-QUALIFIED value
 *   `IFC<TYPE>(<value>)` — required for a SELECT member that is a defined type
 *   (`IFCBOOLEAN(.T.)` in an `IfcTranslationalStiffnessSelect` slot) and for the
 *   `IfcValue` family (`IFCLABEL('x')`, `IFCLENGTHMEASURE(3.)`). `type` is the
 *   IFC type name (`'IfcBoolean'`, `'IfcLengthMeasure'`). It generalizes
 *   `{ real }` (`{ typed: { type: 'IfcReal', value: 450 } }`). The exporter also
 *   auto-qualifies unambiguous SELECT slots without a marker; this is the escape
 *   hatch for the ambiguous ones (a select with several REAL-backed members).
 */
export type IfcAttributeValue =
  | string
  | number
  | boolean
  | null
  | { real: number }
  | { typed: { type: string; value: string | number | boolean } }
  | IfcAttributeValue[];

export interface IfcEntity {
  expressId: number;
  type: string;
  attributes: IfcAttributeValue[];
  /**
   * STEP token-kind side channel (#1799): indices into `attributes` whose
   * TOP-LEVEL source token was a bare enumeration (`.USERDEFINED.` — dotted in
   * the source, unquoted). The value representation is unchanged (an enum is
   * still stored as its dotted string), so existing consumers are unaffected;
   * this channel only records the token KIND, letting consumers distinguish a
   * bare enum from a quoted string that happens to look like one
   * (`'.USERDEFINED.'`) — mirroring the Rust parser's separate
   * `AttributeValue::String` / `AttributeValue::Enum` variants.
   *
   * Optional: absent when the entity has no bare-enum attributes, or when the
   * producer predates / does not track token kinds (hand-built entities,
   * mutation authoring). Nested tokens (inside lists or typed values) are not
   * tracked. Indices are in ascending order.
   */
  enumAttrIndices?: readonly number[];
}
