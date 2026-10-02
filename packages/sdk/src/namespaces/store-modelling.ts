/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Loaded-model modelling methods of bim.store (#6232 D5). */
import type {
  HostedDoorInStoreParams, HostedWindowInStoreParams, OpeningInStoreParams, ElementTypeInStoreParams,
  MaterialInStoreParams, MaterialLayerSetInStoreParams, MaterialLayerSetUsageInStoreParams, WallJoinApplyOptions,
  StairInStoreParams, RailingInStoreParams,
} from '@ifc-lite/create';
import type { BimBackend, EntityRef } from '../types.js';

export class StoreModellingNamespace {
  constructor(protected backend: BimBackend) {}

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
