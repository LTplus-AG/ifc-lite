/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Loaded-model modelling methods of bim.store (#6232 D5). */
import type {
  AlignMode, ElementTransformInput, ElementSplitRequest, ElementTrimExtendParams,
  CopyTransform, CopyArrayParams,
  HostedElementEdit, CurtainWallInStoreParams, GridInStoreParams, GridColumnBinding, ColumnInStoreParams, ProfiledColumnInStoreParams,
  HostedDoorInStoreParams, HostedWindowInStoreParams, OpeningInStoreParams, ElementTypeInStoreParams,
  MaterialInStoreParams, MaterialLayerSetInStoreParams, MaterialLayerSetUsageInStoreParams, WallJoinApplyOptions,
  StairInStoreParams, RailingInStoreParams, InStoreReplacementElement,
} from '@ifc-lite/create';
import type { RoomCommand, RoomCommandResult } from '../store-room-command.js';
import type { BimBackend, EntityRef } from '../types.js';
import type { PhysicalSizePatch } from '../store-physical-types.js';

export class StoreModellingNamespace {
  constructor(protected backend: BimBackend) {}

  async roomCommand(modelId: string, storeyId: number, command: RoomCommand): Promise<RoomCommandResult> {
    const method = this.backend.store.roomCommand;
    if (!method) throw new Error('bim.store.roomCommand: native Room capability is unavailable on this backend');
    return method.call(this.backend.store, modelId, storeyId, command);
  }

  async alignElements(modelId: string, reference: number, targets: readonly number[], mode: AlignMode): Promise<EntityRef[]> {
    const method = this.backend.store.alignElements;
    if (!method) throw new Error('bim.store.alignElements: native Align capability is unavailable on this backend');
    return method.call(this.backend.store, modelId, reference, targets, mode);
  }

  transformElements(modelId: string, expressIds: readonly number[], operation: ElementTransformInput['op']): EntityRef[] {
    const method = this.backend.store.transformElements;
    if (!method) throw new Error('bim.store.transformElements: not available on this backend');
    return method.call(this.backend.store, modelId, expressIds, operation);
  }

  setElementSize(ref: EntityRef, patch: PhysicalSizePatch): EntityRef[] {
    const method = this.backend.store.setElementSize;
    if (!method) throw new Error('bim.store.setElementSize: not available on this backend');
    return method.call(this.backend.store, ref, patch);
  }

  resizeWall(ref: EntityRef, start: [number, number, number], end: [number, number, number], options?: { moveJoinedEnds?: boolean }): EntityRef[] {
    const method = this.backend.store.resizeWall;
    if (!method) throw new Error('bim.store.resizeWall: not available on this backend');
    return method.call(this.backend.store, ref, start, end, options);
  }

  splitElements(modelId: string, requests: readonly ElementSplitRequest[]): { source: EntityRef; added: EntityRef; left: EntityRef; right: EntityRef }[] {
    const method = this.backend.store.splitElements;
    if (!method) throw new Error('bim.store.splitElements: not available on this backend');
    return method.call(this.backend.store, modelId, requests);
  }

  trimExtendElement(ref: EntityRef, params: ElementTrimExtendParams): EntityRef[] {
    const method = this.backend.store.trimExtendElement;
    if (!method) throw new Error('bim.store.trimExtendElement: not available on this backend');
    return method.call(this.backend.store, ref, params);
  }

  /** Paste a dependency-pruned selection in storey-local metres/radians. */
  copyElements(modelId: string, expressIds: readonly number[], transforms: readonly CopyTransform[]): EntityRef[] {
    const method = this.backend.store.copyElements;
    if (!method) throw new Error('bim.store.copyElements: not available on this backend');
    return method.call(this.backend.store, modelId, expressIds, transforms);
  }

  /** Duplicate with its hosted graph and a new GlobalId; offset is storey-local IFC XYZ metres. */
  duplicateElement(ref: EntityRef, options: { offset: [number, number, number]; Name?: string }): EntityRef {
    const method = this.backend.store.duplicateElement;
    if (!method) throw new Error('bim.store.duplicateElement: not available on this backend');
    return method.call(this.backend.store, ref, options);
  }

  /** Linear spacing/fit or polar span, sharing the viewer's placement planner. */
  arrayElements(modelId: string, expressIds: readonly number[], params: CopyArrayParams): EntityRef[] {
    const method = this.backend.store.arrayElements;
    if (!method) throw new Error('bim.store.arrayElements: not available on this backend');
    return method.call(this.backend.store, modelId, expressIds, params);
  }

  /** Move/resize the opening and its filling together. Lengths are metres in the host frame. */
  editHostedElement(ref: EntityRef, patch: HostedElementEdit): EntityRef {
    const method = this.backend.store.editHostedElement;
    if (!method) throw new Error('bim.store.editHostedElement: not available on this backend');
    return method.call(this.backend.store, ref, patch);
  }

  /** Create the curtain wall and all its members/panels in one undo batch. Metres, storey-local. */
  addCurtainWall(modelId: string, storeyExpressId: number, params: CurtainWallInStoreParams): EntityRef {
    const method = this.backend.store.addCurtainWall;
    if (!method) throw new Error('bim.store.addCurtainWall: not available on this backend');
    return method.call(this.backend.store, modelId, storeyExpressId, params);
  }

  /** Create straight tagged grid axes. Position and axis endpoints are metres in their local frame. */
  addGrid(modelId: string, storeyExpressId: number, params: GridInStoreParams): EntityRef {
    const method = this.backend.store.addGrid;
    if (!method) throw new Error('bim.store.addGrid: not available on this backend');
    return method.call(this.backend.store, modelId, storeyExpressId, params);
  }

  /** Create a column at the actual live crossing and retain its IfcGridPlacement binding. */
  addColumnOnGrid(modelId: string, storeyExpressId: number, params: ColumnInStoreParams | ProfiledColumnInStoreParams, binding: GridColumnBinding): EntityRef {
    const method = this.backend.store.addColumnOnGrid;
    if (!method) throw new Error('bim.store.addColumnOnGrid: not available on this backend');
    return method.call(this.backend.store, modelId, storeyExpressId, params, binding);
  }

  /** Remove a single-flight stair and its flight; shared geometry, styles and materials are retained. */
  removeStair(ref: EntityRef): boolean {
    const remove = this.backend.store.removeStair;
    if (!remove) throw new Error('bim.store.removeStair is not supported by this backend');
    return remove.call(this.backend.store, ref);
  }

  /** Add a storey-local straight-run stair and its aggregated flight; lengths are metres, Direction radians. */
  addStair(modelId: string, storeyExpressId: number, params: StairInStoreParams): EntityRef {
    const create = this.backend.store.addStair;
    if (!create) throw new Error('bim.store.addStair is not supported by this backend');
    return create.call(this.backend.store, modelId, storeyExpressId, params);
  }

  /** Add a railing along Path in storey-local metres, including the handrail and its posts. */
  addRailing(modelId: string, storeyExpressId: number, params: RailingInStoreParams): EntityRef {
    const create = this.backend.store.addRailing;
    if (!create) throw new Error('bim.store.addRailing is not supported by this backend');
    return create.call(this.backend.store, modelId, storeyExpressId, params);
  }

  /** Replace a product with canonical storey-local params; a refusal retains its old graph. */
  replaceElement(ref: EntityRef, storeyExpressId: number, element: InStoreReplacementElement): EntityRef {
    const replace = this.backend.store.replaceElement;
    if (!replace) throw new Error('bim.store.replaceElement is not supported by this backend');
    return replace.call(this.backend.store, ref, storeyExpressId, element);
  }

  // -- Openings, hosted fillings, types and materials (#6232 M3) -------------
  // Hosts are existing IfcWall/IfcSlab; params are metres in the host's frame.
  /** Cut an IfcOpeningElement (IfcRelVoidsElement) into a wall (`Offset`, `Sill`, `Width`, `Height`) or
   *  slab (`Position` [x, y], `Width`, `Depth`); the cut spans the host body + 50 mm per face unless `CutDepth`. */
  addOpening(modelId: string, hostExpressId: number, params: OpeningInStoreParams): EntityRef {
    return this.backend.store.addOpening(modelId, hostExpressId, params);
  }

  /** Add an IfcDoor filling a new opening in a wall (IfcRelFillsElement). `Sill` defaults to 0. */
  addHostedDoor(modelId: string, hostExpressId: number, params: HostedDoorInStoreParams): EntityRef {
    return this.backend.store.addHostedDoor(modelId, hostExpressId, params);
  }

  /** Add an IfcWindow filling a new opening in a wall (IfcRelFillsElement), bottom edge at `Sill`. */
  addHostedWindow(modelId: string, hostExpressId: number, params: HostedWindowInStoreParams): EntityRef {
    return this.backend.store.addHostedWindow(modelId, hostExpressId, params);
  }

  /** Join two walls in the same placement frame; returns IfcRelConnectsPathElements. */
  joinWalls(modelId: string, aExpressId: number, bExpressId: number, options?: WallJoinApplyOptions): EntityRef {
    return this.backend.store.joinWalls(modelId, aExpressId, bExpressId, options);
  }

  // IFC4 practice: IfcMaterialLayerSet on the type, a usage of it on each occurrence.
  /** Add an IfcElementType subtype (e.g. `{ Type: 'IfcWallType', Name, PredefinedType }`), laid out for the model's schema. */
  addElementType(modelId: string, params: ElementTypeInStoreParams): EntityRef {
    return this.backend.store.addElementType(modelId, params);
  }

  /** Type objects via IfcRelDefinesByType; an object already typed moves to this type. Returns the relationship. */
  assignType(modelId: string, typeExpressId: number, objectExpressIds: number[]): EntityRef {
    return this.backend.store.assignType(modelId, typeExpressId, objectExpressIds);
  }

  /** Add an IfcMaterial. */
  addMaterial(modelId: string, params: MaterialInStoreParams): EntityRef {
    return this.backend.store.addMaterial(modelId, params);
  }

  /** Add an IfcMaterialLayerSet of IfcMaterialLayers (`MaterialLayers[i].LayerThickness` in metres). */
  addMaterialLayerSet(modelId: string, params: MaterialLayerSetInStoreParams): EntityRef {
    return this.backend.store.addMaterialLayerSet(modelId, params);
  }

  /** Add an IfcMaterialLayerSetUsage (default AXIS2/POSITIVE; `OffsetFromReferenceLine` in metres). */
  addMaterialLayerSetUsage(modelId: string, params: MaterialLayerSetUsageInStoreParams): EntityRef {
    return this.backend.store.addMaterialLayerSetUsage(modelId, params);
  }

  /** Associate a material with objects via IfcRelAssociatesMaterial, replacing their previous one. Returns the relationship. */
  assignMaterial(modelId: string, materialExpressId: number, objectExpressIds: number[]): EntityRef {
    return this.backend.store.assignMaterial(modelId, materialExpressId, objectExpressIds);
  }

}
