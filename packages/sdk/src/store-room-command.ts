/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared native Room command service. Hosts supply meshes, history and commit recording (#6232 D5). */
import {
  RoomLayoutCache, filterRoomFaces, roomCandidatesFromFaces, planRoomCreation, createRoomsInStore,
  storeyFootprintFaceInStore, roomOutline, updateRoomOutlineInStore, applyLayoutOp, readFaces,
  syncRoomLayoutInStore, occupancyTest, existingSpaceFootprintEntriesByStorey,
  type RoomPlateFactory, type RoomWallRect, type SpaceFootprint, type RoomCandidate, type RoomBoundary,
  type LayoutOp, type ElementSplitOptions,
} from '@ifc-lite/create';
import type { CostStoreModelResolution } from './cost-store-backend.js';
import type { EntityRef } from './types.js';

type GlobalIdScope = NonNullable<ElementSplitOptions['globalIdScopes']>[number];

interface RoomCommandSettings {
  readonly signal?: AbortSignal;
  readonly weld?: number;
  readonly minArea?: number;
  readonly boundary?: RoomBoundary;
  readonly height?: number;
  readonly z?: number;
  readonly namePattern?: string;
  readonly PredefinedType?: string;
  readonly ObjectType?: string;
}
export type RoomCommand = RoomCommandSettings & (
  | { readonly action: 'auto' | 'footprint' | 'query' }
  | { readonly action: 'pick'; readonly point: readonly [number, number] }
  | { readonly action: 'update'; readonly expressIds: readonly number[] }
  | { readonly action: 'edit'; readonly operation: LayoutOp; readonly tolerance?: number }
);
export interface RoomCommandResult {
  readonly created: EntityRef[];
  readonly updated: EntityRef[];
  readonly deleted: EntityRef[];
  readonly skipped: EntityRef[];
  readonly candidates: readonly RoomCandidate[];
}
export interface NativeRoomGeometry {
  /** Exactly the native mesh decoder's rectangles, transformed into storey-local metres. */
  readonly walls: readonly RoomWallRect[];
  readonly factory: RoomPlateFactory;
  readonly spaces?: readonly SpaceFootprint[];
  /** Includes native IfcSpace mesh triangle occupancy for faceted source spaces. */
  readonly occupied?: (point: [number, number]) => boolean;
}
export type RoomGeometryProvider = (model: CostStoreModelResolution, storeyId: number) => Promise<NativeRoomGeometry>;
export interface RoomCommandHost {
  /** Actual recorded Undo head, restored exactly by Undo/Redo. */
  historyHead(modelId: string): string;
  /** Record synchronously after native geometry preparation has finished. */
  record<T>(modelId: string, write: (model: CostStoreModelResolution) => T): T;
  /** Viewer injects the same cache its native Room tool already uses. */
  readonly layouts: RoomLayoutCache;
  readonly globalIdScopes?: () => readonly GlobalIdScope[];
}
export type RoomCommandModelResolver = (modelId: string) => CostStoreModelResolution;

const mutationHead = (model: CostStoreModelResolution) => model.mutationView.getMutations().map(m => m.id).join('|');

export function createRoomCommandBackend(resolve: RoomCommandModelResolver, provide: RoomGeometryProvider, host: RoomCommandHost) {
  const modelStores = new Map<string, WeakRef<CostStoreModelResolution['store']>>();
  const running = new Set<string>();
  let generation = 0;
  return {
    async roomCommand(modelId: string, storeyId: number, op: RoomCommand): Promise<RoomCommandResult> {
      op.signal?.throwIfAborted();
      if (running.has(modelId)) throw new Error('Another Room command is preparing this model');
      if (!['auto', 'pick', 'footprint', 'query', 'update', 'edit'].includes(op.action)) throw new Error('Unsupported Room command action');
      if (!Number.isSafeInteger(storeyId) || storeyId <= 0) throw new Error('Room requires a positive storey expressId');
      const weld = op.weld ?? .05, minArea = op.minArea ?? .3, boundary = op.boundary ?? 'inner';
      const height = op.height ?? 3, z = op.z ?? 0;
      if (!Number.isFinite(weld) || weld <= 0 || !Number.isFinite(minArea) || minArea < 0 || !Number.isFinite(height) || height <= 0 || !Number.isFinite(z)) throw new Error('Room settings require finite positive weld/height and nonnegative minimum area');
      if (!['inner', 'center', 'outer'].includes(boundary)) throw new Error('Unsupported room boundary');
      if (op.action === 'update' && (op.expressIds.length === 0 || op.expressIds.length > 10000 || new Set(op.expressIds).size !== op.expressIds.length)) throw new Error('Room update requires 1..10000 unique rooms');
      running.add(modelId);
      try {
        const model = resolve(modelId), head = host.historyHead(modelId), journal = mutationHead(model), epoch = generation;
        const attached = modelStores.has(modelId), previousStore = modelStores.get(modelId)?.deref();
        if (previousStore !== model.store) {
          // Unloading a viewer model must not retain its parsed source. A
          // collected prior identity still means replacement, not first attach.
          if (attached) host.layouts.clearModel(modelId);
          modelStores.set(modelId, new WeakRef(model.store));
        }
        const geometry = await provide(model, storeyId);
        op.signal?.throwIfAborted();
        const current = resolve(modelId);
        if (epoch !== generation || current.store !== model.store || current.mutationView !== model.mutationView || host.historyHead(modelId) !== head || mutationHead(current) !== journal) throw new Error('The model changed while native Room geometry was preparing; retry the command');
        const spaces = geometry.spaces ?? existingSpaceFootprintEntriesByStorey(model.store, model.mutationView).get(storeyId) ?? [];
        const occupied = geometry.occupied ?? occupancyTest(spaces.map(space => space.footprint), []);
        const entry = host.layouts.read(modelId, storeyId, weld, head, geometry.walls.map(wall => wall.corners), geometry.factory);
        const rooms = roomCandidatesFromFaces(filterRoomFaces(entry.faces, op.action === 'edit' || op.action === 'update' ? 0 : minArea), occupied, spaces);
        const ref = (expressId: number): EntityRef => ({ modelId, expressId });
        const result = (created: readonly number[] = [], updated: readonly number[] = [], deleted: readonly number[] = [], skipped: readonly number[] = []): RoomCommandResult => ({ created: created.map(ref), updated: updated.map(ref), deleted: deleted.map(ref), skipped: skipped.map(ref), candidates: rooms });
        if (op.action === 'query') return result();
        if (op.action === 'edit') {
          const tolerance = op.tolerance ?? .01;
          if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error('Room edit tolerance must be positive finite metres');
          const plate = entry.plate.duplicate();
          let transferred = false;
          try {
            if (!applyLayoutOp(plate, op.operation, tolerance)) throw new Error('Room layout edit changed nothing');
            const after = readFaces(plate);
            const sync = host.record(modelId, draft => syncRoomLayoutInStore(draft.store, draft.editor, rooms, after, host.globalIdScopes?.() ?? [], storeyId));
            host.layouts.file(modelId, storeyId, weld, host.historyHead(modelId), entry.walls, plate, after);
            transferred = true;
            return result(sync.created, sync.remesh.filter(id => !sync.created.includes(id)), sync.deleted);
          } finally { if (!transferred) plate.free(); }
        }
        if (op.action === 'update') {
          const updated: number[] = [], skipped: number[] = [];
          host.record(modelId, draft => draft.editor.runAtomic(editor => {
            for (const id of op.expressIds) {
              const res = updateRoomOutlineInStore(draft.store, editor, id, boundary, sid => sid === storeyId ? rooms : []);
              (res.ok ? updated : skipped).push(id);
            }
            if (updated.length === 0) throw new Error('No selected room has a supported current face on this storey');
          }));
          return result([], updated, [], skipped);
        }
        let plans;
        if (op.action === 'footprint') {
          if (spaces.length > 0 || roomCandidatesFromFaces(entry.faces, occupied, spaces).some(room => room.taken)) throw new Error('This storey already has rooms: Footprint would overlap them');
          const face = storeyFootprintFaceInStore(geometry.factory, geometry.walls, weld);
          if (!face) throw new Error('No storey footprint could be derived from these native walls');
          const [candidate] = roomCandidatesFromFaces([face]);
          plans = [{ outline: roomOutline(face, boundary), height, z, Name: (op.namePattern ?? 'Room {n}').replaceAll('{n}', String(spaces.length + 1)), grossArea: candidate.grossArea, netArea: candidate.netArea, derived: true, ...(op.PredefinedType !== undefined ? { PredefinedType: op.PredefinedType } : {}), ...(op.ObjectType !== undefined ? { ObjectType: op.ObjectType } : {}) }];
        } else {
          plans = planRoomCreation(rooms, { action: op.action, ...(op.action === 'pick' ? { point: op.point } : {}), boundary, height, z, existingCount: spaces.length, namePattern: op.namePattern ?? 'Room {n}', ...(op.PredefinedType !== undefined ? { PredefinedType: op.PredefinedType } : {}), ...(op.ObjectType !== undefined ? { ObjectType: op.ObjectType } : {}) });
        }
        if (plans.length === 0) throw new Error('No unoccupied room faces remain on this storey');
        const created = host.record(modelId, draft => createRoomsInStore(draft.store, draft.editor, storeyId, plans));
        return result(created);
      } finally { running.delete(modelId); }
    },
    /** Model-close/backend-dispose must deterministically release all retained native handles. */
    disposeRooms(): void { generation++; host.layouts.clear(); modelStores.clear(); },
  };
}
