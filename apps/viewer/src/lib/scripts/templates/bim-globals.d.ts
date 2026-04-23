/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AUTO-GENERATED — do not edit by hand.
 * Run: npx tsx scripts/generate-bim-globals.ts
 *
 * Type declarations for the sandbox `bim` global.
 * Generated from NAMESPACE_SCHEMAS in bridge-schema.ts.
 */

// ── Entity types ────────────────────────────────────────────────────────

interface BimEntity {
  ref: { modelId: string; expressId: number };
  name: string; Name: string;
  type: string; Type: string;
  globalId: string; GlobalId: string;
  description: string; Description: string;
  objectType: string; ObjectType: string;
}

interface BimPropertySet {
  name: string;
  properties: Array<{ name: string; value: string | number | boolean | null }>;
}

interface BimQuantitySet {
  name: string;
  quantities: Array<{ name: string; value: number | null }>;
}

interface BimAttribute {
  name: string;
  value: string;
}

interface BimClassification {
  system?: string;
  identification?: string;
  name?: string;
  location?: string;
  description?: string;
  path?: string[];
}

interface BimMaterialLayer {
  materialName?: string;
  thickness?: number;
  isVentilated?: boolean;
  name?: string;
  category?: string;
}

interface BimMaterialProfile {
  materialName?: string;
  name?: string;
  category?: string;
}

interface BimMaterialConstituent {
  materialName?: string;
  name?: string;
  fraction?: number;
  category?: string;
}

interface BimMaterial {
  type: 'Material' | 'MaterialLayerSet' | 'MaterialProfileSet' | 'MaterialConstituentSet' | 'MaterialList';
  name?: string;
  description?: string;
  layers?: BimMaterialLayer[];
  profiles?: BimMaterialProfile[];
  constituents?: BimMaterialConstituent[];
  materials?: string[];
}

interface BimTypeProperties {
  typeName: string;
  typeId: number;
  properties: BimPropertySet[];
}

interface BimDocument {
  name?: string;
  description?: string;
  location?: string;
  identification?: string;
  purpose?: string;
  intendedUse?: string;
  revision?: string;
  confidentiality?: string;
}

interface BimRelationships {
  voids: Array<{ id: number; name?: string; type: string }>;
  fills: Array<{ id: number; name?: string; type: string }>;
  groups: Array<{ id: number; name?: string }>;
  connections: Array<{ id: number; name?: string; type: string }>;
}

interface BimModelInfo {
  id: string;
  name: string;
  schemaVersion: string;
  entityCount: number;
  fileSize: number;
}

interface BimFileAttachment {
  name: string;
  type: string;
  size: number;
  rowCount?: number;
  columns?: string[];
  hasTextContent: boolean;
}

// ── Namespace declarations ──────────────────────────────────────────────

declare const bim: {
  /** Model operations */
  model: {
    /** List loaded models */
    list(): BimModelInfo[];
    /** Get active model */
    active(): BimModelInfo | null;
    /** Get active model ID */
    activeId(): string | null;
    /** Load IFC content into the 3D viewer for preview */
    loadIfc(content: string, filename: string): void;
  };
  /** Query entities */
  query: {
    /** Get all entities */
    all(): BimEntity[];
    /** Filter by IFC type e.g. 'IfcWall' */
    byType(...types: string[]): BimEntity[];
    /** Get entity by model ID and express ID */
    entity(modelId: string, expressId: number): BimEntity | null;
    /** Get all named string/enum attributes for an entity */
    attributes(entity: BimEntity): BimAttribute[];
    /** Get all IfcPropertySet data for an entity */
    properties(entity: BimEntity): BimPropertySet[];
    /** Get all IfcElementQuantity data for an entity */
    quantities(entity: BimEntity): BimQuantitySet[];
    /** Get a single property value from an entity */
    property(entity: BimEntity, psetName: string, propName: string): string | number | boolean | null;
    /** Get classification references for an entity */
    classifications(entity: BimEntity): BimClassification[];
    /** Get material assignment for an entity */
    materials(entity: BimEntity): BimMaterial | null;
    /** Get type-level property sets for an entity */
    typeProperties(entity: BimEntity): BimTypeProperties | null;
    /** Get linked document references for an entity */
    documents(entity: BimEntity): BimDocument[];
    /** Get structural relationship summary for an entity */
    relationships(entity: BimEntity): BimRelationships;
    /** Get a single quantity value from an entity */
    quantity(entity: BimEntity, qsetName: string, quantityName: string): number | null;
    /** Get related entities by IFC relationship type */
    related(entity: BimEntity, relType: string, direction: 'forward' | 'inverse'): BimEntity[];
    /** Get the spatial container of an entity */
    containedIn(entity: BimEntity): BimEntity | null;
    /** Get entities contained in a spatial container */
    contains(entity: BimEntity): BimEntity[];
    /** Get the parent aggregate of an entity */
    decomposedBy(entity: BimEntity): BimEntity | null;
    /** Get aggregated children of an entity */
    decomposes(entity: BimEntity): BimEntity[];
    /** Get the containing building storey of an entity */
    storey(entity: BimEntity): BimEntity | null;
    /** Get the spatial/aggregation path from project to entity */
    path(entity: BimEntity): BimEntity[];
    /** List all building storeys */
    storeys(): BimEntity[];
    /** Get the current viewer selection as entities */
    selection(): BimEntity[];
  };
  /** Viewer control */
  viewer: {
    /** Colorize entities e.g. '#ff0000' */
    colorize(entities: BimEntity[], color: string): void;
    /** Batch colorize with [{entities, color}] */
    colorizeAll(batches: Array<{ entities: BimEntity[]; color: string }>): void;
    /** Hide entities */
    hide(entities: BimEntity[]): void;
    /** Show entities */
    show(entities: BimEntity[]): void;
    /** Isolate entities */
    isolate(entities: BimEntity[]): void;
    /** Select entities */
    select(entities: BimEntity[]): void;
    /** Fly camera to entities */
    flyTo(entities: BimEntity[]): void;
    /** Reset all colors */
    resetColors(): void;
    /** Reset all visibility */
    resetVisibility(): void;
  };
  /** Property editing */
  mutate: {
    /** Set an IfcPropertySet or quantity value (not a root IFC attribute) */
    setProperty(entity: unknown, psetName: string, propName: string, value: unknown): void;
    /** Set a root IFC attribute such as Name, Description, ObjectType, or Tag */
    setAttribute(entity: unknown, attrName: string, value: string): void;
    /** Delete a property */
    deleteProperty(entity: unknown, psetName: string, propName: string): void;
    /** Undo last mutation */
    undo(modelId: string): void;
    /** Redo undone mutation */
    redo(modelId: string): void;
  };
  /** Lens visualization */
  lens: {
    /** Get built-in lens presets */
    presets(): unknown[];
  };
  /** IFC creation from scratch */
  create: {
    /** Create a new IFC project. Returns a creator handle (number). */
    project(params: { Name?: string; Description?: string; Schema?: string; LengthUnit?: string; Author?: string; Organization?: string }): number;
    /** Generate the IFC STEP file content. Returns { content, entities, stats }. */
    toIfc(handle: number): { content: string; entities: Array<{ expressId: number; type: string; Name?: string }>; stats: { entityCount: number; fileSize: number } };
    /** Assign a named colour to an element. Call before toIfc(). */
    setColor(handle: number, elementId: number, name: string, rgb: unknown): void;
    /** Create an IfcWorkSchedule. Returns schedule expressId. */
    addIfcWorkSchedule(handle: number, params: { Name: string; StartTime: string; FinishTime?: string; CreationDate?: string; Description?: string; Identification?: string; Purpose?: string; Duration?: string; TotalFloat?: string; PredefinedType?: 'ACTUAL' | 'BASELINE' | 'PLANNED' | 'USERDEFINED' | 'NOTDEFINED' }): number;
    /** Create an IfcWorkPlan (groups multiple schedules). Returns plan expressId. */
    addIfcWorkPlan(handle: number, params: { Name: string; StartTime: string; FinishTime?: string; CreationDate?: string; Description?: string; Identification?: string; Purpose?: string; Duration?: string; PredefinedType?: 'ACTUAL' | 'BASELINE' | 'PLANNED' | 'USERDEFINED' | 'NOTDEFINED' }): number;
    /** Create an IfcTask. Provide ScheduleStart + ScheduleFinish (or ScheduleDuration) for time fields. Returns task expressId. */
    addIfcTask(handle: number, params: { Name: string; Description?: string; Identification?: string; LongDescription?: string; Status?: string; WorkMethod?: string; IsMilestone?: boolean; Priority?: number; ObjectType?: string; ScheduleStart?: string; ScheduleFinish?: string; ScheduleDuration?: string; ActualStart?: string; ActualFinish?: string; ActualDuration?: string; EarlyStart?: string; EarlyFinish?: string; LateStart?: string; LateFinish?: string; FreeFloat?: string; TotalFloat?: string; IsCritical?: boolean; DurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED'; Completion?: number; PredefinedType?: 'ATTENDANCE' | 'CONSTRUCTION' | 'DEMOLITION' | 'DISMANTLE' | 'DISPOSAL' | 'INSTALLATION' | 'LOGISTIC' | 'MAINTENANCE' | 'MOVE' | 'OPERATION' | 'REMOVAL' | 'RENOVATION' | 'USERDEFINED' | 'NOTDEFINED' | 'ADJUSTMENT' | 'CALIBRATION' | 'EMERGENCY' | 'INSPECTION' | 'SAFETY' | 'SHUTDOWN' | 'STARTUP' | 'TESTING' | 'TROUBLESHOOTING' }): number;
    /** Link predecessor → successor tasks via IfcRelSequence. Returns relationship expressId. */
    addIfcRelSequence(handle: number, predecessorTaskId: number, successorTaskId: number, params: { SequenceType?: 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH' | 'USERDEFINED' | 'NOTDEFINED'; TimeLag?: string; LagDurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED'; UserDefinedSequenceType?: string }): number;
    /** Canonical IfcRelAssignsToControl — bind IfcObjectDefinitions (tasks or sub-schedules) to an IfcControl (IfcWorkSchedule/IfcWorkPlan). Returns relationship expressId. */
    addIfcRelAssignsToControl(handle: number, relatingControlId: number, relatedObjectIds: number[]): number;
    /** Canonical IfcRelAssignsToProcess — bind products to an IfcProcess (task). Drives the 4D Gantt animation. Returns relationship expressId. */
    addIfcRelAssignsToProcess(handle: number, relatingProcessId: number, relatedObjectIds: number[]): number;
    /** Canonical IfcRelNests — nest child objects under a parent (task WBS hierarchy). Returns relationship expressId. */
    addIfcRelNests(handle: number, relatingObjectId: number, relatedObjectIds: number[]): number;
    /** Ergonomic alias for addIfcRelAssignsToControl — assign tasks to a work schedule. Returns relationship expressId. */
    assignTasksToWorkSchedule(handle: number, scheduleId: number, taskIds: number[]): number;
    /** Ergonomic alias for addIfcRelAssignsToControl — attach work schedules to a parent IfcWorkPlan. Returns relationship expressId. */
    assignSchedulesToWorkPlan(handle: number, planId: number, scheduleIds: number[]): number;
    /** Ergonomic alias for addIfcRelAssignsToProcess — bind products to a task. Returns relationship expressId. */
    assignProductsToTask(handle: number, taskId: number, productIds: number[]): number;
    /** Ergonomic alias for addIfcRelNests — nest child tasks under a summary parent. Returns relationship expressId. */
    nestTasks(handle: number, parentTaskId: number, childTaskIds: number[]): number;
    /** Create ANY IFC type extruded along a Start→End axis. Returns expressId. */
    addAxisElement(handle: number, storeyId: number, params: unknown): number;
    /** Create ANY IFC type with a profile at a placement. Returns expressId. */
    addElement(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcBeam. Returns expressId. */
    addIfcBeam(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcBuildingElementProxy. Returns expressId. */
    addIfcBuildingElementProxy(handle: number, storeyId: number, params: unknown): number;
    /** Add a building storey. Returns storey expressId. */
    addIfcBuildingStorey(handle: number, params: unknown): number;
    /** Add IfcCircularColumn. Returns expressId. */
    addIfcCircularColumn(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcColumn. Returns expressId. */
    addIfcColumn(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcCurtainWall. Returns expressId. */
    addIfcCurtainWall(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcDoor. Returns expressId. */
    addIfcDoor(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcElementQuantity. Returns expressId. */
    addIfcElementQuantity(handle: number, elementId: number, params: unknown): number;
    /** Add IfcFooting. Returns expressId. */
    addIfcFooting(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcFurnishingElement. Returns expressId. */
    addIfcFurnishingElement(handle: number, storeyId: number, params: unknown): number;
    /** Add a dual-pitch gable roof. `Slope` is in radians. Returns roof expressId. */
    addIfcGableRoof(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcHollowCircularColumn. Returns expressId. */
    addIfcHollowCircularColumn(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcIShapeBeam. Returns expressId. */
    addIfcIShapeBeam(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcLShapeMember. Returns expressId. */
    addIfcLShapeMember(handle: number, storeyId: number, params: unknown): number;
    /** Associate a material with an element via IfcRelAssociatesMaterial (deferred to toIfc). Returns nothing. */
    addIfcMaterial(handle: number, elementId: number, params: unknown): void;
    /** Add IfcMember. Returns expressId. */
    addIfcMember(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcPile. Returns expressId. */
    addIfcPile(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcPlate. Returns expressId. */
    addIfcPlate(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcPropertySet. Returns expressId. */
    addIfcPropertySet(handle: number, elementId: number, params: unknown): number;
    /** Add IfcRailing. Returns expressId. */
    addIfcRailing(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcRamp. Returns expressId. */
    addIfcRamp(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcRectangleHollowBeam. Returns expressId. */
    addIfcRectangleHollowBeam(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcRoof. Returns expressId. */
    addIfcRoof(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcSlab. Returns expressId. */
    addIfcSlab(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcSpace. Returns expressId. */
    addIfcSpace(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcStair. Returns expressId. */
    addIfcStair(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcTShapeMember. Returns expressId. */
    addIfcTShapeMember(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcUShapeMember. Returns expressId. */
    addIfcUShapeMember(handle: number, storeyId: number, params: unknown): number;
    /** Add IfcWall. Returns expressId. */
    addIfcWall(handle: number, storeyId: number, params: unknown): number;
    /** Add a door hosted in a wall opening. Position is wall-local [alongWall, 0, baseHeight]. Returns door expressId. */
    addIfcWallDoor(handle: number, wallId: number, params: unknown): number;
    /** Add a window hosted in a wall opening. Position is wall-local [alongWall, 0, sillHeight]. Returns window expressId. */
    addIfcWallWindow(handle: number, wallId: number, params: unknown): number;
    /** Add IfcWindow. Returns expressId. */
    addIfcWindow(handle: number, storeyId: number, params: unknown): number;
    /** Create a profile from a ProfileDef union. Returns profile ID. */
    createProfile(handle: number, profile: unknown): number;
    /** Get the world placement ID for use with addLocalPlacement. */
    getWorldPlacementId(handle: number): number;
  };
  /** Uploaded file attachments */
  files: {
    /** List uploaded file attachments available to scripts */
    list(): BimFileAttachment[];
    /** Get raw text content for an uploaded attachment by file name */
    text(name: string): string | null;
    /** Get parsed CSV/TSV rows for an uploaded attachment by file name */
    csv(name: string): Record<string, string>[] | null;
    /** Get parsed CSV column names for an uploaded attachment by file name */
    csvColumns(name: string): string[];
  };
  /** 4D / IFC construction schedule reader (IfcTask, IfcWorkSchedule, IfcRelSequence) */
  schedule: {
    /** Full schedule extraction — tasks, dependencies, and work schedules. */
    data(modelId?: string): { HasSchedule: boolean; WorkSchedules: Array<{ GlobalId: string; ExpressId: number; Name: string; Description?: string; Identification?: string; CreationDate?: string; StartTime?: string; FinishTime?: string; Purpose?: string; Duration?: string; PredefinedType?: string; Kind: 'WorkSchedule' | 'WorkPlan'; TaskGlobalIds: string[] }>; Tasks: Array<{ GlobalId: string; ExpressId: number; Name: string; Description?: string; ObjectType?: string; Identification?: string; LongDescription?: string; Status?: string; WorkMethod?: string; IsMilestone: boolean; Priority?: number; PredefinedType?: string; ParentTaskGlobalId?: string; ChildTaskGlobalIds: string[]; AssignedProductExpressIds: number[]; AssignedProductGlobalIds: string[]; ControllingScheduleGlobalIds: string[]; TaskTime?: { ScheduleStart?: string; ScheduleFinish?: string; ScheduleDuration?: string; ActualStart?: string; ActualFinish?: string; ActualDuration?: string; EarlyStart?: string; EarlyFinish?: string; LateStart?: string; LateFinish?: string; FreeFloat?: string; TotalFloat?: string; RemainingTime?: string; StatusTime?: string; IsCritical?: boolean; Completion?: number; DurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED' } }>; Sequences: Array<{ RelatingProcessGlobalId: string; RelatedProcessGlobalId: string; SequenceType: 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH' | 'USERDEFINED' | 'NOTDEFINED'; UserDefinedSequenceType?: string; TimeLagSeconds?: number; TimeLagDuration?: string }> };
    /** All IfcTask entities with their times and assigned products. */
    tasks(modelId?: string): Array<{ GlobalId: string; ExpressId: number; Name: string; Description?: string; ObjectType?: string; Identification?: string; LongDescription?: string; Status?: string; WorkMethod?: string; IsMilestone: boolean; Priority?: number; PredefinedType?: string; ParentTaskGlobalId?: string; ChildTaskGlobalIds: string[]; AssignedProductExpressIds: number[]; AssignedProductGlobalIds: string[]; ControllingScheduleGlobalIds: string[]; TaskTime?: { ScheduleStart?: string; ScheduleFinish?: string; ScheduleDuration?: string; ActualStart?: string; ActualFinish?: string; ActualDuration?: string; EarlyStart?: string; EarlyFinish?: string; LateStart?: string; LateFinish?: string; FreeFloat?: string; TotalFloat?: string; RemainingTime?: string; StatusTime?: string; IsCritical?: boolean; Completion?: number; DurationType?: 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED' } }>;
    /** All IfcWorkSchedule and IfcWorkPlan containers. */
    workSchedules(modelId?: string): Array<{ GlobalId: string; ExpressId: number; Name: string; Description?: string; Identification?: string; CreationDate?: string; StartTime?: string; FinishTime?: string; Purpose?: string; Duration?: string; PredefinedType?: string; Kind: 'WorkSchedule' | 'WorkPlan'; TaskGlobalIds: string[] }>;
    /** All IfcRelSequence dependency edges (FS/SS/FF/SF, with optional IfcLagTime). */
    sequences(modelId?: string): Array<{ RelatingProcessGlobalId: string; RelatedProcessGlobalId: string; SequenceType: 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH' | 'USERDEFINED' | 'NOTDEFINED'; UserDefinedSequenceType?: string; TimeLagSeconds?: number; TimeLagDuration?: string }>;
  };
  /** Data export */
  export: {
    /** Export entities to CSV string */
    csv(entities: BimEntity[], options: { columns: string[]; filename?: string; separator?: string }): string;
    /** Export entities to JSON array */
    json(entities: BimEntity[], columns: string[]): Record<string, unknown>[];
    /** Export entities to IFC STEP text. Pass filename to auto-download a valid .ifc file */
    ifc(entities: BimEntity[], options: { schema?: "IFC2X3" | "IFC4" | "IFC4X3"; filename?: string; includeMutations?: boolean; visibleOnly?: boolean }): string | Uint8Array;
    /** Trigger a browser file download with the given content. mimeType defaults to text/plain. */
    download(content: string, filename: string, mimeType?: string): void;
  };
};
