/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/create — IFC creation from scratch
 *
 * Build valid IFC4 STEP files programmatically with building elements,
 * geometry, property sets, and element quantities.
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

  // Scheduling / 4D (IfcWorkSchedule, IfcTask, IfcRelSequence)
  // Canonical IFC-prefixed names are preferred; legacy short names are kept
  // as aliases for existing callers.
  IfcWorkScheduleParams,
  IfcWorkPlanParams,
  IfcTaskParams,
  IfcRelSequenceParams,
  IfcWorkScheduleType,
  IfcTaskPredefinedType,
  IfcTaskDurationType,
  IfcRelSequenceType,
  WorkScheduleParams,
  WorkPlanParams,
  TaskParams,
  SequenceParams,
  WorkScheduleType,
  TaskPredefinedType,
  TaskDurationType,
  SequenceType,

  // Results
  CreatedEntity,
  CreateResult,
} from './types.js';
