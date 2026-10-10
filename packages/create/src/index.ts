/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/create — IFC creation from scratch
 *
 * Build valid IFC4 STEP files programmatically with building elements,
 * geometry, property sets, and element quantities.
 *
 * Element coordinates are STOREY-RELATIVE: every `addIfcXxx(storeyId, …)`
 * chains the product's `IfcLocalPlacement` to that storey's placement, which
 * is where `Elevation` is applied. Pass `Z = 0` for something standing on the
 * storey floor, whatever the storey's elevation is.
 *
 * ```ts
 * import { IfcCreator } from '@ifc-lite/create';
 *
 * const creator = new IfcCreator({ Name: 'My Project' });
 * const storey = creator.addIfcBuildingStorey({ Name: 'Ground Floor', Elevation: 0 });
 * creator.addIfcWall(storey, {
 *   Start: [0, 0, 0], End: [5, 0, 0],
 *   Thickness: 0.2, Height: 3,
 * });
 * const { content } = creator.toIfc();
 * ```
 */

export { IfcCreator } from './ifc-creator.js';

// Terrain & survey emitters (IFC4X3) — the entity set the LandXML→IFC v1
// mapping needs. See `docs/architecture/landxml-to-ifc-mapping.md`.
export type {
  GeoreferencingParams, SurveyPointParams, SurveyPropertySetParams,
  TerrainSurfaceParams, TerrainSurfaceResult, TerrainWriter,
} from './ifc-creator-terrain.js';

// LandXML → IFC4X3 v1. Contract: `docs/architecture/landxml-to-ifc-mapping.md`.
export {
  LANDXML_IFC_MAPPING_VERSION, landXmlGlobalId, landXmlToIfc, type LandXmlIfcOptions,
} from './landxml/landxml-to-ifc.js';
export {
  TRANSVERSE_MERCATOR_BOUNDS, checkCoordinateOrder, type CrsPlausibilityBounds,
} from './landxml/coordinate-plausibility.js';
export {
  alignmentMappingOf, alignmentRefusalMessage, collectRefusals, isMappableSurface, refusalReason,
} from './landxml/refusals.js';
export {
  ALIGNMENT_POSITION_TOLERANCE_M, cogoPointResolver, isAlignmentRecord, mapAlignments,
  type AlignmentMapping, type HorizontalSegment, type HorizontalSegmentType, type MappedAlignment,
  type PointResolver, type RefusedAlignment,
} from './landxml/alignment-mapping.js';
export type { AlignmentParams, AlignmentResult } from './ifc-creator-alignment.js';
export type { AlignmentVerticalParams } from './ifc-creator-alignment-vertical.js';
export type { VerticalSegment, VerticalSegmentType } from './landxml/profile-geometry.js';
export type { StationEquationParams } from './ifc-creator-alignment-referents.js';
export type * from './landxml/source-types.js';
export type * from './landxml/result-types.js';

// In-store authoring API, kept separate from create-from-scratch types.
export * from './in-store/index.js';

export type {
  // Geometry primitives
  Point3D,
  Point2D,
  Placement3D,
  RectangleProfile,
  ArbitraryProfile,
  CircleProfile,
  CircleHollowProfile,
  IShapeProfile,
  LShapeProfile,
  TShapeProfile,
  UShapeProfile,
  CShapeProfile,
  RectangleHollowProfile,
  ProfileDef,
  RectangularOpening,

  // Generic element creation (low-level API)
  GenericElementParams,
  AxisElementParams,

  // Element parameters
  ElementAttributes,
  WallParams,
  SlabParams,
  ColumnParams,
  BeamParams,
  StairParams,
  RoofParams,
  GableRoofParams,
  WallDoorParams,
  WallWindowParams,
  DoorParams,
  WindowParams,
  RampParams,
  RailingParams,
  PlateParams,
  MemberParams,
  FootingParams,
  PileParams,
  SpaceParams,
  CurtainWallParams,
  FurnishingParams,
  ProxyParams,

  // Properties & quantities
  PropertyType,
  PropertyMeasureType,
  PropertyDef,
  PropertySetDef,
  QuantityKind,
  QuantityDef,
  QuantitySetDef,

  // Materials
  MaterialLayerDef,
  MaterialDef,

  // Spatial structure
  ProjectParams,
  SiteParams,
  BuildingParams,
  StoreyParams,

  // Scheduling / 4D (IfcWorkSchedule, IfcTask, IfcRelSequence, IfcWorkCalendar)
  // Canonical IFC-prefixed names are preferred; legacy short names are kept
  // as aliases for existing callers.
  IfcWorkScheduleParams,
  IfcWorkPlanParams,
  IfcTaskParams,
  IfcRelSequenceParams,
  IfcWorkCalendarParams,
  IfcWorkTimeParams,
  IfcRecurrencePatternParams,
  IfcTimePeriodParams,
  IfcWorkScheduleType,
  IfcTaskPredefinedType,
  IfcTaskDurationType,
  IfcRelSequenceType,
  IfcWorkCalendarType,
  IfcRecurrenceType,
  WorkScheduleParams,
  WorkPlanParams,
  TaskParams,
  SequenceParams,
  WorkCalendarParams,
  WorkTimeParams,
  RecurrencePatternParams,
  TimePeriodParams,
  WorkScheduleType,
  TaskPredefinedType,
  TaskDurationType,
  SequenceType,
  WorkCalendarType,
  RecurrenceType,

  // Results
  CreatedEntity,
  CreateResult,
} from './types.js';
// Cost / 5D authoring (IfcCostSchedule, IfcCostItem, IfcCostValue)
export type {
  CostArithmeticOperator,
  CostItemParams,
  CostItemPredefinedType,
  CostMeasureType,
  CostQuantityKind,
  CostQuantityParams,
  CostScheduleParams,
  CostSchedulePredefinedType,
  CostSIUnitType,
  CostTypedValue,
  CostValueParams,
  SIUnitParams,
} from './types-cost.js';

export { copyBatchInStore, copySourcesInStore, copiedProductsInStore } from './in-store/copy-batch.js';
export { arrayCopyTransforms, type CopyArrayParams } from './in-store/copy-array.js';
export type { CopyTransform } from './in-store/copy-product.js';

export { setElementSizeInStore } from './in-store/element-size-edit.js';
export { resizeWallInStore } from './in-store/wall-size-edit.js';

export { transformElementsInStore, type ElementTransformInput, type StoreyTransformOp } from './in-store/element-transform-edit.js';
export { splitElementsInStore, type ElementSplitRequest, type ElementSplitOptions } from './in-store/element-split.js';

export { trimExtendElementInStore, type ElementTrimExtendParams } from './in-store/element-trim-extend.js';

export { RoomLayoutCache } from './in-store/room-layout-cache.js';
export { readFaces, applyLayoutOp, filterRoomFaces, type LayoutOp, type RoomPlateFactory } from './in-store/room-layout-core.js';
export { roomOutline, roomCandidatesFromFaces, occupancyTest, type RoomCandidate, type RoomBoundary } from './in-store/room-candidates.js';
export { createRoomsInStore, updateRoomOutlineInStore, syncRoomLayoutInStore } from './in-store/room-store.js';
export { storeyFootprintFaceInStore, type RoomWallRect } from './in-store/room-footprint-native.js';
export { planRoomCreation } from './in-store/room-creation-plan.js';

export { wallRectsFromMeshes, roomFrameToModelWorld, roomFramePlanOffsets } from './in-store/room-wall-rects.js';
export { floorToFloorHeight } from './in-store/room-floor-height.js';
export { effectiveStoreyElevation } from './in-store/room-storey-elevation.js';
export { effectiveStoreyIds } from './in-store/edit/effective-storeys.js';
export { effectiveRoomIdsByStorey } from './in-store/room-population.js';
export { spaceMeshTriangles } from './in-store/room-space-meshes.js';

export { ALIGN_MODES, alignsAlongU, planBoxOf, pickBox, edgeOf, alignShift, shiftBox, alignMoves, type AlignMode, type PlanBox } from './in-store/align-boxes.js';
export { alignmentStoreyInStore, alignElementsInStore, type ElementAlignParams } from './in-store/element-align.js';

export { planStoreyReassignment, planStoreyReassignmentCandidates, type StoreyReassignmentPlan } from './in-store/storey-reassignment-plan.js';
export { reassignElementsToStoreyInStore } from './in-store/storey-reassignment.js';
