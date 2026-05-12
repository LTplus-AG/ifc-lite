/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types for IFC creation from scratch.
 *
 * All coordinate values are in metres. All angles are in radians.
 * Uses IFC PascalCase names per AGENTS.md.
 */

// ============================================================================
// Geometry primitives
// ============================================================================

/** 3D point [x, y, z] in metres */
export type Point3D = [number, number, number];

/** 2D point [x, y] in metres */
export type Point2D = [number, number];

/** Axis-aligned placement: origin + optional Z direction + optional X direction */
export interface Placement3D {
  Location: Point3D;
  Axis?: Point3D;        // Z direction, default [0,0,1]
  RefDirection?: Point3D; // X direction, default [1,0,0]
}

/** 2D rectangle profile (width along X, depth along Y, centered at origin) */
export interface RectangleProfile {
  ProfileType: 'AREA';
  XDim: number;
  YDim: number;
}

/** Arbitrary closed profile defined by a polyline */
export interface ArbitraryProfile {
  ProfileType: 'AREA';
  OuterCurve: Point2D[];
}

/** Circle profile (centred at origin) */
export interface CircleProfile {
  ProfileType: 'AREA';
  Radius: number;
}

/** Hollow circle profile (centred at origin) */
export interface CircleHollowProfile {
  ProfileType: 'AREA';
  Radius: number;
  WallThickness: number;
}

/** I-shape profile (wide-flange / H-shape, centred at origin) */
export interface IShapeProfile {
  ProfileType: 'AREA';
  /** Overall width of flanges */
  OverallWidth: number;
  /** Overall depth (height) */
  OverallDepth: number;
  /** Web thickness */
  WebThickness: number;
  /** Flange thickness */
  FlangeThickness: number;
  /** Fillet radius at web-flange junction */
  FilletRadius?: number;
}

/** L-shape profile (angle section, corner at origin) */
export interface LShapeProfile {
  ProfileType: 'AREA';
  /** Depth (vertical leg) */
  Depth: number;
  /** Width (horizontal leg) */
  Width: number;
  /** Thickness of both legs */
  Thickness: number;
  /** Fillet radius at inner corner */
  FilletRadius?: number;
}

/** T-shape profile (tee section, centred at origin) */
export interface TShapeProfile {
  ProfileType: 'AREA';
  /** Discriminator — identifies this as an IFC T-shape profile */
  Shape: 'IfcTShapeProfileDef';
  /** Flange width */
  FlangeWidth: number;
  /** Overall depth */
  Depth: number;
  /** Web thickness */
  WebThickness: number;
  /** Flange thickness */
  FlangeThickness: number;
  /** Fillet radius */
  FilletRadius?: number;
}

/** U-shape profile (channel section, centred at origin) */
export interface UShapeProfile {
  ProfileType: 'AREA';
  /** Discriminator — identifies this as an IFC U-shape profile */
  Shape: 'IfcUShapeProfileDef';
  /** Overall depth */
  Depth: number;
  /** Flange width */
  FlangeWidth: number;
  /** Web thickness */
  WebThickness: number;
  /** Flange thickness */
  FlangeThickness: number;
  /** Fillet radius */
  FilletRadius?: number;
}

/** C-shape profile (cold-formed channel, centred at origin) */
export interface CShapeProfile {
  ProfileType: 'AREA';
  /** Overall depth */
  Depth: number;
  /** Overall width */
  Width: number;
  /** Wall thickness */
  WallThickness: number;
  /** Girth (lip length) */
  Girth: number;
}

/** Rectangle hollow profile (tube section, centred at origin) */
export interface RectangleHollowProfile {
  ProfileType: 'AREA';
  /** Outer width */
  XDim: number;
  /** Outer height */
  YDim: number;
  /** Wall thickness */
  WallThickness: number;
  /** Inner fillet radius */
  InnerFilletRadius?: number;
  /** Outer fillet radius */
  OuterFilletRadius?: number;
}

export type ProfileDef =
  | RectangleProfile
  | ArbitraryProfile
  | CircleProfile
  | CircleHollowProfile
  | IShapeProfile
  | LShapeProfile
  | TShapeProfile
  | UShapeProfile
  | CShapeProfile
  | RectangleHollowProfile;

/** Rectangular opening cut (width, height, position relative to host element) */
export interface RectangularOpening {
  Name?: string;
  Width: number;
  Height: number;
  /** Position of opening centre relative to host element origin */
  Position: Point3D;
}

// ============================================================================
// Building element parameters
// ============================================================================

/** Common attributes shared by all building elements */
export interface ElementAttributes {
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

/** Wall: extruded rectangle profile */
export interface WallParams extends ElementAttributes {
  /** Start point of wall axis [x, y, z] */
  Start: Point3D;
  /** End point of wall axis [x, y, z] */
  End: Point3D;
  /** Wall thickness (perpendicular to axis) */
  Thickness: number;
  /** Wall height */
  Height: number;
  /** Rectangular openings in the wall */
  Openings?: RectangularOpening[];
}

/** Slab: extruded rectangle or arbitrary profile */
export interface SlabParams extends ElementAttributes {
  /** Placement origin */
  Position: Point3D;
  /** Slab thickness (extrusion height, along Z) */
  Thickness: number;
  /** Width (X dimension) — used when Profile is omitted */
  Width?: number;
  /** Depth (Y dimension) — used when Profile is omitted */
  Depth?: number;
  /** Custom profile outline (overrides Width/Depth) */
  Profile?: Point2D[];
  /** Rectangular openings in the slab */
  Openings?: RectangularOpening[];
}

/** Column: extruded rectangle profile */
export interface ColumnParams extends ElementAttributes {
  /** Base point */
  Position: Point3D;
  /** Column width (X) */
  Width: number;
  /** Column depth (Y) */
  Depth: number;
  /** Column height (Z) */
  Height: number;
}

/** Beam: extruded rectangle profile along an axis */
export interface BeamParams extends ElementAttributes {
  /** Start point */
  Start: Point3D;
  /** End point */
  End: Point3D;
  /** Beam width */
  Width: number;
  /** Beam height (depth of section) */
  Height: number;
}

/** Stair: simplified parametric stair (straight run) */
export interface StairParams extends ElementAttributes {
  /** Base point of first riser */
  Position: Point3D;
  /** Direction angle in XY plane (radians, 0 = +X) */
  Direction?: number;
  /** Number of risers */
  NumberOfRisers: number;
  /** Riser height */
  RiserHeight: number;
  /** Tread length (going) */
  TreadLength: number;
  /** Stair width */
  Width: number;
}

/** Roof: extruded slab with optional slope */
export interface RoofParams extends ElementAttributes {
  /** Placement origin */
  Position: Point3D;
  /** Roof thickness */
  Thickness: number;
  /** Width (X dimension) */
  Width: number;
  /** Depth (Y dimension) */
  Depth: number;
  /** Slope angle in radians (0 = flat). Slope is along X axis. */
  Slope?: number;
}

/** Gable roof: dual-pitch roof generated from a rectangular footprint */
export interface GableRoofParams extends ElementAttributes {
  /** Placement origin at the footprint minimum corner */
  Position: Point3D;
  /** Footprint width along X */
  Width: number;
  /** Footprint depth along Y */
  Depth: number;
  /** Roof thickness measured normal to each roof plane */
  Thickness: number;
  /** Roof pitch angle in radians */
  Slope: number;
  /** Optional symmetric overhang applied to all eaves/rakes */
  Overhang?: number;
}

/** Wall-hosted door: aligned to a host wall and its opening */
export interface WallDoorParams extends ElementAttributes {
  /** Position relative to wall local axes: [alongWall, 0, baseHeight] */
  Position: Point3D;
  /** Door width along wall axis */
  Width: number;
  /** Door height upward from base */
  Height: number;
  /** Door thickness through wall. Defaults to host wall thickness. */
  Thickness?: number;
  /** Predefined type (IFC4 IfcDoorTypeEnum) */
  PredefinedType?: 'DOOR' | 'GATE' | 'TRAPDOOR' | 'USERDEFINED' | 'NOTDEFINED';
  /** Operation type (IFC4 IfcDoorTypeOperationEnum) */
  OperationType?: 'SINGLE_SWING_LEFT' | 'SINGLE_SWING_RIGHT' | 'DOUBLE_DOOR_SINGLE_SWING' | 'DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_LEFT' | 'DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_RIGHT' | 'DOUBLE_SWING_LEFT' | 'DOUBLE_SWING_RIGHT' | 'DOUBLE_DOOR_DOUBLE_SWING' | 'SLIDING_TO_LEFT' | 'SLIDING_TO_RIGHT' | 'DOUBLE_DOOR_SLIDING' | 'FOLDING_TO_LEFT' | 'FOLDING_TO_RIGHT' | 'DOUBLE_DOOR_FOLDING' | 'REVOLVING' | 'ROLLINGUP' | 'SWING_FIXED_LEFT' | 'SWING_FIXED_RIGHT' | 'USERDEFINED' | 'NOTDEFINED';
}

/** Wall-hosted window: aligned to a host wall and its opening */
export interface WallWindowParams extends ElementAttributes {
  /** Position relative to wall local axes: [alongWall, 0, sillHeight] */
  Position: Point3D;
  /** Window width along wall axis */
  Width: number;
  /** Window height upward from sill */
  Height: number;
  /** Window thickness through wall. Defaults to host wall thickness. */
  Thickness?: number;
  /** Partitioning type */
  PartitioningType?: 'SINGLE_PANEL' | 'DOUBLE_PANEL_HORIZONTAL' | 'DOUBLE_PANEL_VERTICAL' | 'TRIPLE_PANEL_HORIZONTAL' | 'NOTDEFINED';
}

/** Door: standalone world-aligned element */
export interface DoorParams extends ElementAttributes {
  /** Door position in world coordinates */
  Position: Point3D;
  /** Door width */
  Width: number;
  /** Door height */
  Height: number;
  /** Door thickness (panel depth) */
  Thickness?: number;
  /** Predefined type (IFC4 IfcDoorTypeEnum) */
  PredefinedType?: 'DOOR' | 'GATE' | 'TRAPDOOR' | 'USERDEFINED' | 'NOTDEFINED';
  /** Operation type (IFC4 IfcDoorTypeOperationEnum) */
  OperationType?: 'SINGLE_SWING_LEFT' | 'SINGLE_SWING_RIGHT' | 'DOUBLE_DOOR_SINGLE_SWING' | 'DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_LEFT' | 'DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_RIGHT' | 'DOUBLE_SWING_LEFT' | 'DOUBLE_SWING_RIGHT' | 'DOUBLE_DOOR_DOUBLE_SWING' | 'SLIDING_TO_LEFT' | 'SLIDING_TO_RIGHT' | 'DOUBLE_DOOR_SLIDING' | 'FOLDING_TO_LEFT' | 'FOLDING_TO_RIGHT' | 'DOUBLE_DOOR_FOLDING' | 'REVOLVING' | 'ROLLINGUP' | 'SWING_FIXED_LEFT' | 'SWING_FIXED_RIGHT' | 'USERDEFINED' | 'NOTDEFINED';
}

/** Window: standalone world-aligned element */
export interface WindowParams extends ElementAttributes {
  /** Window position in world coordinates */
  Position: Point3D;
  /** Window width */
  Width: number;
  /** Window height */
  Height: number;
  /** Window thickness (frame depth) */
  Thickness?: number;
  /** Partitioning type */
  PartitioningType?: 'SINGLE_PANEL' | 'DOUBLE_PANEL_HORIZONTAL' | 'DOUBLE_PANEL_VERTICAL' | 'TRIPLE_PANEL_HORIZONTAL' | 'NOTDEFINED';
}

/** Ramp: extruded profile with optional slope */
export interface RampParams extends ElementAttributes {
  /** Placement origin */
  Position: Point3D;
  /** Ramp width */
  Width: number;
  /** Ramp length (horizontal run) */
  Length: number;
  /** Ramp thickness */
  Thickness: number;
  /** Rise (vertical height change) */
  Rise?: number;
}

/** Railing: extruded along a path */
export interface RailingParams extends ElementAttributes {
  /** Start point */
  Start: Point3D;
  /** End point */
  End: Point3D;
  /** Railing height */
  Height: number;
  /** Rail diameter/width */
  Width?: number;
}

/** Plate: thin flat element (e.g. steel plate) */
export interface PlateParams extends ElementAttributes {
  /** Placement origin */
  Position: Point3D;
  /** Width (X) */
  Width: number;
  /** Depth (Y) */
  Depth: number;
  /** Plate thickness (Z) */
  Thickness: number;
  /** Custom profile outline (overrides Width/Depth) */
  Profile?: Point2D[];
}

/** Member: structural member (e.g. steel brace, strut) */
export interface MemberParams extends ElementAttributes {
  /** Start point */
  Start: Point3D;
  /** End point */
  End: Point3D;
  /** Cross-section width */
  Width: number;
  /** Cross-section height */
  Height: number;
}

/** Footing: foundation element */
export interface FootingParams extends ElementAttributes {
  /** Placement origin (top centre) */
  Position: Point3D;
  /** Footing width (X) */
  Width: number;
  /** Footing depth (Y) */
  Depth: number;
  /** Footing height (Z, extends downward) */
  Height: number;
  /** Footing type */
  PredefinedType?: 'STRIP_FOOTING' | 'PAD_FOOTING' | 'PILE_CAP' | 'NOTDEFINED';
}

/** Pile: deep foundation element */
export interface PileParams extends ElementAttributes {
  /** Top of pile position */
  Position: Point3D;
  /** Pile length (extends downward) */
  Length: number;
  /** Pile diameter (circular) or width (rectangular) */
  Diameter: number;
  /** If true, uses rectangular cross-section instead of circular */
  IsRectangular?: boolean;
  /** Depth for rectangular piles (default = Diameter) */
  RectangularDepth?: number;
}

/** Space: an enclosed volume (room) */
export interface SpaceParams extends ElementAttributes {
  /** Placement origin */
  Position: Point3D;
  /** Width (X) */
  Width: number;
  /** Depth (Y) */
  Depth: number;
  /** Height (Z) */
  Height: number;
  /** Long name (room name) */
  LongName?: string;
  /** Custom profile outline (overrides Width/Depth) */
  Profile?: Point2D[];
}

/** Curtain wall: planar curtain wall panel */
export interface CurtainWallParams extends ElementAttributes {
  /** Start point of wall axis */
  Start: Point3D;
  /** End point of wall axis */
  End: Point3D;
  /** Curtain wall height */
  Height: number;
  /** Panel thickness */
  Thickness?: number;
}

/** Furnishing element: generic furniture/equipment */
export interface FurnishingParams extends ElementAttributes {
  /** Placement origin */
  Position: Point3D;
  /** Bounding box width (X) */
  Width: number;
  /** Bounding box depth (Y) */
  Depth: number;
  /** Bounding box height (Z) */
  Height: number;
  /** Direction angle in XY plane (radians, 0 = +X) */
  Direction?: number;
}

/** Proxy element: generic element for anything not covered by specific types */
export interface ProxyParams extends ElementAttributes {
  /** Placement origin */
  Position: Point3D;
  /** Width (X) */
  Width: number;
  /** Depth (Y) */
  Depth: number;
  /** Height (Z) */
  Height: number;
  /** Custom profile outline (overrides Width/Depth) */
  Profile?: Point2D[];
  /** Proxy type hint */
  ProxyType?: string;
}

// ============================================================================
// Property / Quantity helpers
// ============================================================================

/** IFC property value types */
export type PropertyType = 'IfcLabel' | 'IfcText' | 'IfcIdentifier' | 'IfcReal' | 'IfcInteger' | 'IfcBoolean' | 'IfcLogical';

/** Single property definition */
export interface PropertyDef {
  Name: string;
  NominalValue: string | number | boolean;
  /** Defaults to IfcLabel for strings, IfcReal for numbers, IfcBoolean for booleans */
  Type?: PropertyType;
}

/** Property set to attach to an element */
export interface PropertySetDef {
  Name: string;
  Properties: PropertyDef[];
}

/** Quantity types */
export type QuantityKind = 'IfcQuantityLength' | 'IfcQuantityArea' | 'IfcQuantityVolume' | 'IfcQuantityCount' | 'IfcQuantityWeight';

/** Single quantity definition */
export interface QuantityDef {
  Name: string;
  Value: number;
  Kind: QuantityKind;
}

/** Element quantity set to attach to an element */
export interface QuantitySetDef {
  Name: string;
  Quantities: QuantityDef[];
}

// ============================================================================
// Material definitions
// ============================================================================

/** A single layer within a material layer set */
export interface MaterialLayerDef {
  /** Material name for this layer */
  Name: string;
  /** Layer thickness in metres */
  Thickness: number;
  /** Category (e.g. 'Structural', 'Insulation', 'Finish') */
  Category?: string;
  /** Whether the layer allows airflow */
  IsVentilated?: boolean;
}

/** Material definition — simple or layered */
export interface MaterialDef {
  /** Material or layer-set name */
  Name: string;
  /** Category (used for simple materials without layers) */
  Category?: string;
  /** If provided, creates IfcMaterialLayerSet; otherwise simple IfcMaterial */
  Layers?: MaterialLayerDef[];
}

// ============================================================================
// Spatial structure
// ============================================================================

/** Project-level options */
export interface ProjectParams {
  Name?: string;
  Description?: string;
  Schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  /** Length unit: 'METRE' (default), 'MILLIMETRE', 'FOOT' */
  LengthUnit?: string;
  Author?: string;
  Organization?: string;
}

/** Site-level options */
export interface SiteParams {
  Name?: string;
  Description?: string;
}

/** Building-level options */
export interface BuildingParams {
  Name?: string;
  Description?: string;
}

/** Building storey (floor) options */
export interface StoreyParams {
  Name?: string;
  Description?: string;
  Elevation: number;
}

// ============================================================================
// Scheduling / 4D (IfcWorkSchedule, IfcTask, IfcRelSequence)
// ============================================================================

export type WorkScheduleType =
  | 'ACTUAL' | 'BASELINE' | 'PLANNED'
  | 'USERDEFINED' | 'NOTDEFINED';

/**
 * IFC task-type enum — union of IFC4 and IFC4X3 `IfcTaskTypeEnum` values.
 *
 * IFC4 introduced the first 14. IFC4X3 added 9 more to cover the
 * operations/maintenance lifecycle (ADJUSTMENT through TROUBLESHOOTING).
 * The superset is exposed here so scripts can author schedules for
 * either schema; IFC4 files that try to round-trip the newer values
 * may fail validation on strict toolchains — caller's responsibility.
 */
export type TaskPredefinedType =
  // IFC4 values
  | 'ATTENDANCE' | 'CONSTRUCTION' | 'DEMOLITION' | 'DISMANTLE'
  | 'DISPOSAL' | 'INSTALLATION' | 'LOGISTIC' | 'MAINTENANCE'
  | 'MOVE' | 'OPERATION' | 'REMOVAL' | 'RENOVATION'
  | 'USERDEFINED' | 'NOTDEFINED'
  // IFC4X3 additions (operations / maintenance lifecycle)
  | 'ADJUSTMENT' | 'CALIBRATION' | 'EMERGENCY' | 'INSPECTION'
  | 'SAFETY' | 'SHUTDOWN' | 'STARTUP' | 'TESTING' | 'TROUBLESHOOTING';

export type TaskDurationType =
  | 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED';

export type SequenceType =
  | 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH'
  | 'USERDEFINED' | 'NOTDEFINED';

/**
 * IfcWorkSchedule parameters.
 *
 * Timestamps are ISO 8601 datetimes (e.g. "2024-05-01T08:00:00").
 * `Duration` / `TotalFloat` use ISO 8601 durations (e.g. "P30D", "PT8H").
 */
export interface WorkScheduleParams {
  Name: string;
  Description?: string;
  Identification?: string;
  CreationDate?: string;
  StartTime: string;
  FinishTime?: string;
  Purpose?: string;
  Duration?: string;
  TotalFloat?: string;
  PredefinedType?: WorkScheduleType;
}

/** IfcWorkPlan parameters — identical shape to IfcWorkSchedule. */
export interface WorkPlanParams extends WorkScheduleParams {}

/** Canonical IFC-prefixed alias for {@link WorkScheduleParams}. */
export type IfcWorkScheduleParams = WorkScheduleParams;
/** Canonical IFC-prefixed alias for {@link WorkPlanParams}. */
export type IfcWorkPlanParams = WorkPlanParams;
/** Canonical IFC-prefixed alias for {@link WorkScheduleType}. */
export type IfcWorkScheduleType = WorkScheduleType;
/** Canonical IFC-prefixed alias for {@link TaskPredefinedType}. */
export type IfcTaskPredefinedType = TaskPredefinedType;
/** Canonical IFC-prefixed alias for {@link TaskDurationType}. */
export type IfcTaskDurationType = TaskDurationType;

/**
 * IfcTask parameters.
 *
 * When any of the *Start / *Finish / *Duration / IsCritical / Completion
 * fields is supplied, an IfcTaskTime is created and linked.
 */
export interface TaskParams {
  Name: string;
  Description?: string;
  ObjectType?: string;
  Identification?: string;
  LongDescription?: string;
  Status?: string;
  WorkMethod?: string;
  IsMilestone?: boolean;
  Priority?: number;
  PredefinedType?: TaskPredefinedType;
  /** ISO 8601 datetime */
  ScheduleStart?: string;
  ScheduleFinish?: string;
  ScheduleDuration?: string;
  ActualStart?: string;
  ActualFinish?: string;
  ActualDuration?: string;
  EarlyStart?: string;
  EarlyFinish?: string;
  LateStart?: string;
  LateFinish?: string;
  FreeFloat?: string;
  TotalFloat?: string;
  RemainingTime?: string;
  StatusTime?: string;
  IsCritical?: boolean;
  DurationType?: TaskDurationType;
  /** Percent complete 0..100 */
  Completion?: number;
}

/** Canonical IFC-prefixed alias for {@link TaskParams}. */
export type IfcTaskParams = TaskParams;

/** IfcRelSequence parameters (predecessor → successor edge). */
export interface IfcRelSequenceParams {
  SequenceType?: IfcRelSequenceType;
  /** ISO 8601 duration (e.g. "P2D"). Negative durations indicate leads. */
  TimeLag?: string;
  /** Duration type applied to the lag (default WORKTIME). */
  LagDurationType?: TaskDurationType;
  UserDefinedSequenceType?: string;
}

/** @deprecated Use {@link IfcRelSequenceParams}. */
export type SequenceParams = IfcRelSequenceParams;

/** Canonical alias using the IFC EXPRESS enum name. */
export type IfcRelSequenceType = SequenceType;

// ============================================================================
// Creation result
// ============================================================================

/** Reference to a created entity (expressId within the created file) */
export interface CreatedEntity {
  expressId: number;
  type: string;
  Name?: string;
}

/** Result of toIfc() */
export interface CreateResult {
  /** Complete IFC STEP file content */
  content: string;
  /** All created entities */
  entities: CreatedEntity[];
  /** Statistics */
  stats: {
    entityCount: number;
    fileSize: number;
  };
}

// ============================================================================
// Generic element creation (low-level API)
// ============================================================================

/**
 * Parameters for the generic addElement() method.
 * Allows creating ANY IFC entity type with ANY geometry creation method.
 *
 * ```ts
 * creator.addElement(storeyId, {
 *   IfcType: 'IFCFLOWSEGMENT',
 *   Placement: { Location: [0, 0, 0] },
 *   Profile: { ProfileType: 'AREA', Radius: 0.1 },
 *   Depth: 5,
 * });
 * ```
 */
export interface GenericElementParams extends ElementAttributes {
  /**
   * IFC entity type name in UPPERCASE (e.g. 'IFCFLOWSEGMENT', 'IFCFLOWFITTING',
   * 'IFCELECTRICALAPPLIANCE', 'IFCWALLSTANDARDCASE', etc.).
   *
   * Any IFC product type can be used. The only requirement is that it extends
   * IfcProduct in the IFC schema (i.e. it can have a placement and representation).
   */
  IfcType: string;

  /** 3D placement for the element */
  Placement: Placement3D;

  /**
   * Cross-section profile to extrude. Supports all profile types:
   * Rectangle, Circle, CircleHollow, IShape, LShape, TShape, UShape, CShape,
   * RectangleHollow, or Arbitrary (polyline).
   */
  Profile: ProfileDef;

  /** Extrusion depth (length along the extrusion direction) */
  Depth: number;

  /**
   * Extrusion direction in local coordinates. Default: [0, 0, 1] (upward / along local Z).
   * Use [1, 0, 0] for along X, [0, 1, 0] for along Y, etc.
   */
  ExtrusionDirection?: Point3D;

  /**
   * Optional predefined type token (without surrounding dots).
   * The serializer wraps it as `.TOKEN.` in the STEP output.
   * E.g. 'RIGIDSEGMENT', 'NOTDEFINED'
   */
  PredefinedType?: string;
}

/**
 * Parameters for creating an extruded element along an axis (Start → End).
 * The profile is extruded along the axis between Start and End.
 *
 * ```ts
 * creator.addAxisElement(storeyId, {
 *   IfcType: 'IFCPIPESEGMENT',
 *   Start: [0, 0, 3],
 *   End: [5, 0, 3],
 *   Profile: { ProfileType: 'AREA', Radius: 0.05 },
 * });
 * ```
 */
export interface AxisElementParams extends ElementAttributes {
  /** IFC entity type name in UPPERCASE */
  IfcType: string;
  /** Start point of the element axis */
  Start: Point3D;
  /** End point of the element axis */
  End: Point3D;
  /** Cross-section profile (extruded along the axis) */
  Profile: ProfileDef;
  /** Optional predefined type token without dots, e.g. 'RIGIDSEGMENT'. Serializer wraps as .TOKEN. */
  PredefinedType?: string;
}
