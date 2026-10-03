/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store` openings, wall-hosted fillings, type objects and materials on a
 * loaded model (#6232, M3 builder parity). Split out
 * of `types.ts` (allowlisted, at budget) like `store-structural-types.ts`, and
 * like it the param shapes come straight from `@ifc-lite/create`.
 */

import type {
  ElementTypeInStoreParams,
  MaterialInStoreParams,
  MaterialLayerSetInStoreParams,
  MaterialLayerSetUsageInStoreParams,
  HostedDoorInStoreParams,
  HostedWindowInStoreParams,
  OpeningInStoreParams,
  WallJoinApplyOptions,
  InStoreReplacementElement,
  StairInStoreParams,
  RailingInStoreParams,
} from '@ifc-lite/create';
import type { EntityRef } from './types.js';

export interface ModellingStoreBackendMethods {
  /** Optional capability: replace a live product and its uniquely owned stair flight atomically. */
  replaceElement?(ref: EntityRef, storeyExpressId: number, element: InStoreReplacementElement): EntityRef;
  /** Optional host capability: a storey-local IfcStair aggregating one IfcStairFlight. Returns the stair. */
  addStair?(modelId: string, storeyExpressId: number, params: StairInStoreParams): EntityRef;
  /** Optional host capability: an IfcRailing along a storey-local polyline. Returns the railing. */
  addRailing?(modelId: string, storeyExpressId: number, params: RailingInStoreParams): EntityRef;
  /** Optional host capability: atomically remove a uniquely owned single-flight stair assembly. */
  removeStair?(ref: EntityRef): boolean;
  /** Join two straight walls through IfcRelConnectsPathElements, rewriting their bodies/axes atomically. Returns the relationship. */
  joinWalls(modelId: string, aExpressId: number, bExpressId: number, options?: WallJoinApplyOptions): EntityRef;
  /** `IfcOpeningElement` + `IfcRelVoidsElement` cut into an existing IfcWall or IfcSlab. Returns the opening. */
  addOpening(modelId: string, hostExpressId: number, params: OpeningInStoreParams): EntityRef;
  /** `IfcDoor` in a new opening of an IfcWall, linked by `IfcRelFillsElement`. Returns the door. */
  addHostedDoor(modelId: string, hostExpressId: number, params: HostedDoorInStoreParams): EntityRef;
  /** `IfcWindow` in a new opening of an IfcWall, linked by `IfcRelFillsElement`. Returns the window. */
  addHostedWindow(modelId: string, hostExpressId: number, params: HostedWindowInStoreParams): EntityRef;
  /** An `IfcElementType` subtype (`IfcWallType`, `IfcDoorType`, ...), laid out for the model's schema. Returns the type. */
  addElementType(modelId: string, params: ElementTypeInStoreParams): EntityRef;
  /** Type objects via `IfcRelDefinesByType`, extending the type's relationship and detaching them from a previous type. Returns the relationship. */
  assignType(modelId: string, typeExpressId: number, objectExpressIds: number[]): EntityRef;
  /** An `IfcMaterial`. */
  addMaterial(modelId: string, params: MaterialInStoreParams): EntityRef;
  /** An `IfcMaterialLayerSet` with one `IfcMaterialLayer` per entry (thicknesses in metres). Returns the set. */
  addMaterialLayerSet(modelId: string, params: MaterialLayerSetInStoreParams): EntityRef;
  /** An `IfcMaterialLayerSetUsage` of a layer set, for a wall or slab occurrence. */
  addMaterialLayerSetUsage(modelId: string, params: MaterialLayerSetUsageInStoreParams): EntityRef;
  /** Associate a material (any IfcMaterialSelect) with objects via `IfcRelAssociatesMaterial`, replacing their previous association. Returns the relationship. */
  assignMaterial(modelId: string, materialExpressId: number, objectExpressIds: number[]): EntityRef;
}
