/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/sdk — The scripting SDK for ifc-lite
 *
 * Single entry point for all BIM automation:
 *
 * ```ts
 * import { createBimContext } from '@ifc-lite/sdk';
 *
 * // Embedded mode (viewer internal)
 * const bim = createBimContext({ backend: myLocalBackend });
 *
 * // Connected mode (cross-tab)
 * import { BroadcastTransport } from '@ifc-lite/sdk';
 * const transport = new BroadcastTransport('ifc-lite');
 * const bim = createBimContext({ transport });
 *
 * // Use the API
 * const walls = bim.query().byType('IfcWall').toArray();
 * bim.viewer.colorize(walls.map(w => w.ref), '#ff0000');
 * ```
 */

// ============================================================================
// Core
// ============================================================================

export { BimContext, createBimContext } from './context.js';

// ============================================================================
// Types
// ============================================================================

export type {
  // Entity references
  EntityRef,
  EntityRefString,
  EntityData,
  EntityAttributeData,
  PropertySetData,
  PropertyData,
  QuantitySetData,
  QuantityData,
  ClassificationData,
  MaterialData,
  MaterialLayerData,
  MaterialProfileData,
  MaterialConstituentData,
  TypePropertiesData,
  DocumentData,
  EntityRelationshipsData,

  // Model
  ModelInfo,
  FileAttachmentInfo,
  SchemaVersion,

  // Query
  QueryDescriptor,
  QueryFilter,
  ComparisonOp,

  // Viewer
  CameraState,
  ProjectionMode,
  SectionPlane,

  // Spatial
  AABB,
  SpatialPlane,
  SpatialFrustum,

  // Mutation
  MutationRecord,

  // Events
  BimEventType,
  BimEventData,
  BimEventHandler,

  // Transport protocol
  SdkRequest,
  SdkResponse,
  SdkEvent,
  Transport,

  // Backend
  BimBackend,
  BimContextOptions,

  // Backend namespace interfaces
  ModelBackendMethods,
  QueryBackendMethods,
  SelectionBackendMethods,
  VisibilityBackendMethods,
  ViewerBackendMethods,
  MutateBackendMethods,
  SpatialBackendMethods,
  ExportBackendMethods,
  LensBackendMethods,
  FilesBackendMethods,
  ScheduleBackendMethods,

  // Schedule data
  ScheduleExtractionData,
  ScheduleTaskData,
  ScheduleTaskTimeData,
  ScheduleSequenceData,
  WorkScheduleData,
  ScheduleSequenceType,
  ScheduleTaskDurationType,
} from './types.js';

export { entityRefToString, stringToEntityRef, dispatchToBackend } from './types.js';

// ============================================================================
// Namespaces (for type access)
// ============================================================================

export { QueryBuilder, QueryNamespace } from './namespaces/query.js';
export { ModelNamespace } from './namespaces/model.js';
export { ViewerNamespace } from './namespaces/viewer.js';
export { MutateNamespace } from './namespaces/mutate.js';
export { LensNamespace } from './namespaces/lens.js';
export { ExportNamespace } from './namespaces/export.js';
export type { ExportCsvOptions, ExportGltfOptions, ExportStepOptions } from './namespaces/export.js';

// IDS — full validation, facets, constraints, translation
export { IDSNamespace } from './namespaces/ids.js';
export type { IDSValidationSummary, IDSSupportedLocale, IDSValidateOptions } from './namespaces/ids.js';

// BCF — full collaboration: topics, viewpoints, comments, GUID, colors, IDS→BCF
export { BCFNamespace } from './namespaces/bcf.js';
export type { TopicOptions, CommentOptions, ViewpointOptions, IDSBCFOptions } from './namespaces/bcf.js';

// Drawing — section cuts, styles, symbols, sheets, SVG, graphic overrides
export { DrawingNamespace } from './namespaces/drawing.js';
export type { SectionCutOptions, FloorPlanOptions, SVGExportOptions, GraphicOverrideOptions, SheetOptions } from './namespaces/drawing.js';

// List — entity tables, column discovery, CSV export
export { ListNamespace } from './namespaces/list.js';
export type { ListColumn, ListCondition, ListDefinition } from './namespaces/list.js';

export { SpatialNamespace } from './namespaces/spatial.js';
export { EventsNamespace } from './namespaces/events.js';
export { CreateNamespace } from './namespaces/create.js';
export { FilesNamespace } from './namespaces/files.js';
export { ScheduleNamespace } from './namespaces/schedule.js';

// bSDD — buildingSMART Data Dictionary property/classification lookup
export { BsddNamespace } from './namespaces/bsdd.js';
export type { BsddClassInfo, BsddClassProperty, BsddSearchResult, BsddOptions } from './namespaces/bsdd.js';

// Sandbox — secure script execution in QuickJS-WASM
export { SandboxNamespace } from './namespaces/sandbox.js';
export type { SandboxConfig, SandboxPermissions, SandboxLimits, ScriptResult } from './namespaces/sandbox.js';

// ============================================================================
// Re-export creation types for convenience
// ============================================================================

export { IfcCreator } from '@ifc-lite/create';
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

  // Element parameters — structural
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
  PlateParams,
  MemberParams,
  FootingParams,
  PileParams,

  // Element parameters — architectural
  DoorParams,
  WindowParams,
  RampParams,
  RailingParams,
  SpaceParams,
  CurtainWallParams,
  FurnishingParams,
  ProxyParams,

  // Properties & quantities
  PropertySetDef,
  QuantitySetDef,
  PropertyDef,
  QuantityDef,
  PropertyType,
  QuantityKind,

  // Materials
  MaterialDef,
  MaterialLayerDef,

  // Spatial structure
  ProjectParams,
  SiteParams,
  BuildingParams,
  StoreyParams,

  // Scheduling / 4D — canonical IFC-prefixed names + legacy aliases
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
} from '@ifc-lite/create';

// ============================================================================
// Transport
// ============================================================================

export { BroadcastTransport } from './transport/broadcast.js';
export { MessagePortTransport } from './transport/message-port.js';
export { RemoteBackend } from './transport/remote-backend.js';

// ============================================================================
// Host (viewer side)
// ============================================================================

export { BimHost } from './host.js';
