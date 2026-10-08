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
import { StoreEditor } from '@ifc-lite/mutations';
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

/** Native preparation must retry after concurrent state changes or busy ownership. */
export class RoomCommandConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'RoomCommandConflictError'; }
}

const overlayRevision = (model: CostStoreModelResolution) => model.mutationView.getMutationRevision();

/** An inert native draft. Approval commits this whole action, never a subset of Auto faces. */
export interface PreparedRoomCommand {
  readonly result: RoomCommandResult;
  readonly preview: CostStoreModelResolution;
  validate(): void;
  commit(): RoomCommandResult;
  dispose(): void;
}

/** Copy only native fields; an unrelated file-supplied object is never cloned into an approval. */
function capturedCommand(command: RoomCommand): RoomCommand {
  const settings = { signal: command.signal, weld: command.weld, minArea: command.minArea,
    boundary: command.boundary, height: command.height, z: command.z, namePattern: command.namePattern,
    PredefinedType: command.PredefinedType, ObjectType: command.ObjectType };
  switch (command.action) {
    case 'query': case 'auto': case 'footprint': return { ...settings, action: command.action };
    case 'pick': return { ...settings, action: 'pick', point: [command.point[0], command.point[1]] };
    case 'update': return { ...settings, action: 'update', expressIds: [...command.expressIds] };
    case 'edit': {
      const operation = command.operation;
      switch (operation.kind) {
        case 'prune': return { ...settings, action: 'edit', tolerance: command.tolerance, operation: { kind: 'prune' } };
        case 'drag': return { ...settings, action: 'edit', tolerance: command.tolerance, operation: { kind: 'drag', from: [operation.from[0], operation.from[1]], to: [operation.to[0], operation.to[1]] } };
        case 'split': return { ...settings, action: 'edit', tolerance: command.tolerance, operation: { kind: 'split', a: [operation.a[0], operation.a[1]], b: [operation.b[0], operation.b[1]] } };
        case 'remove': return { ...settings, action: 'edit', tolerance: command.tolerance, operation: { kind: 'remove', at: [operation.at[0], operation.at[1]] } };
      }
    }
  }
}

export function createRoomCommandBackend(resolve: RoomCommandModelResolver, provide: RoomGeometryProvider, host: RoomCommandHost) {
  const modelStores = new Map<string, WeakRef<CostStoreModelResolution['store']>>();
  const running = new Set<string>();
  const preparations = new Map<string, number>();
  let generation = 0;
  async function prepareRoomCommand(modelId: string, storeyId: number, command: RoomCommand): Promise<PreparedRoomCommand> {
    const signal = command.signal;
    signal?.throwIfAborted();
    if (running.has(modelId)) throw new RoomCommandConflictError('Another Room command is preparing this model');
    if (!['auto', 'pick', 'footprint', 'query', 'update', 'edit'].includes(command.action)) throw new Error('Unsupported Room command action');
    if (command.action === 'update' && (!Array.isArray(command.expressIds) || command.expressIds.length === 0 || command.expressIds.length > 10000 || !command.expressIds.every(id => Number.isSafeInteger(id) && id > 0) || new Set(command.expressIds).size !== command.expressIds.length)) throw new Error('Room update requires 1..10000 unique positive safe-integer rooms');
    const op = capturedCommand(command);
    if (!Number.isSafeInteger(storeyId) || storeyId <= 0) throw new Error('Room requires a positive storey expressId');
    const weld = op.weld ?? .05, minArea = op.minArea ?? .3, boundary = op.boundary ?? 'inner';
    const height = op.height ?? 3, z = op.z ?? 0;
    if (!Number.isFinite(weld) || weld <= 0 || !Number.isFinite(minArea) || minArea < 0 || !Number.isFinite(height) || height <= 0 || !Number.isFinite(z)) throw new Error('Room settings require finite positive weld/height and nonnegative minimum area');
    if (!['inner', 'center', 'outer'].includes(boundary)) throw new Error('Unsupported room boundary');
    running.add(modelId);
    const sequence = (preparations.get(modelId) ?? 0) + 1;
    preparations.set(modelId, sequence);
    try {
      const model = resolve(modelId), head = host.historyHead(modelId), revision = overlayRevision(model), epoch = generation;
      const currentModel = () => {
        signal?.throwIfAborted();
        const current = resolve(modelId);
        if (epoch !== generation || preparations.get(modelId) !== sequence || current.store !== model.store || current.mutationView !== model.mutationView || host.historyHead(modelId) !== head || overlayRevision(current) !== revision) throw new RoomCommandConflictError('The model changed while native Room geometry was preparing; retry the command');
        return current;
      };
      const attached = modelStores.has(modelId), previousStore = modelStores.get(modelId)?.deref();
      if (previousStore !== model.store) {
        if (attached) host.layouts.clearModel(modelId);
        modelStores.set(modelId, new WeakRef(model.store));
      }
      const geometry = await provide(model, storeyId);
      currentModel();
      const spaces = geometry.spaces ?? existingSpaceFootprintEntriesByStorey(model.store, model.mutationView).get(storeyId) ?? [];
      const occupied = geometry.occupied ?? occupancyTest(spaces.map(space => space.footprint), []);
      const entry = host.layouts.read(modelId, storeyId, weld, head, geometry.walls.map(wall => wall.corners), geometry.factory);
      const layoutVersion = host.layouts.version();
      const rooms = roomCandidatesFromFaces(filterRoomFaces(entry.faces, op.action === 'edit' || op.action === 'update' ? 0 : minArea), occupied, spaces);
      const ref = (expressId: number): EntityRef => ({ modelId, expressId });
      const result = (created: readonly number[] = [], updated: readonly number[] = [], deleted: readonly number[] = [], skipped: readonly number[] = []): RoomCommandResult => ({ created: created.map(ref), updated: updated.map(ref), deleted: deleted.map(ref), skipped: skipped.map(ref), candidates: structuredClone(rooms) });
      const prepare = (write: (draft: CostStoreModelResolution) => RoomCommandResult, afterCommit?: () => void, release?: () => void): PreparedRoomCommand => {
        let disposed = false, committed = false;
        let applied: RoomCommandResult | null = null;
        const draft = model.mutationView.prepareAtomic(view => {
          const preview = { ...model, editor: new StoreEditor(model.store, view), mutationView: view };
          return { preview, result: write(preview) };
        });
        const validate = () => {
          if (disposed || committed) throw new RoomCommandConflictError('This Room preparation is no longer available; prepare it again');
          currentModel();
          if (host.layouts.version() !== layoutVersion) throw new RoomCommandConflictError('The native Room layout changed; prepare it again');
          draft.validate();
        };
        return { result: structuredClone(draft.result.result), preview: draft.result.preview, validate,
          commit: () => {
            validate();
            applied = op.action === 'query' ? draft.result.result : host.record(modelId, write);
            committed = true;
            afterCommit?.();
            return structuredClone(applied);
          },
          dispose: () => { if (!disposed) { disposed = true; release?.(); } },
        };
      };
      if (op.action === 'query') return prepare(() => result());
      if (op.action === 'edit') {
        const tolerance = op.tolerance ?? .01;
        if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error('Room edit tolerance must be positive finite metres');
        const plate = entry.plate.duplicate();
        let transferred = false;
        try {
          if (!applyLayoutOp(plate, op.operation, tolerance)) throw new Error('Room layout edit changed nothing');
          const after = readFaces(plate);
          return prepare(draft => {
            const sync = syncRoomLayoutInStore(draft.store, draft.editor, rooms, after, host.globalIdScopes?.() ?? [], storeyId);
            return result(sync.created, sync.remesh.filter(id => !sync.created.includes(id)), sync.deleted);
          }, () => {
            host.layouts.file(modelId, storeyId, weld, host.historyHead(modelId), entry.walls, plate, after);
            transferred = true;
          }, () => { if (!transferred) plate.free(); });
        } catch (error) { if (!transferred) plate.free(); throw error; }
      }
      if (op.action === 'update') return prepare(draft => {
        const updated: number[] = [], skipped: number[] = [];
        draft.editor.runAtomic(editor => {
          for (const id of op.expressIds) {
            const res = updateRoomOutlineInStore(draft.store, editor, id, boundary, sid => sid === storeyId ? rooms : []);
            (res.ok ? updated : skipped).push(id);
          }
          if (updated.length === 0) throw new Error('No selected room has a supported current face on this storey');
        });
        return result([], updated, [], skipped);
      });
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
      return prepare(draft => result(createRoomsInStore(draft.store, draft.editor, storeyId, plans)));
    } finally { running.delete(modelId); }
  }
  return {
    prepareRoomCommand,
    async roomCommand(modelId: string, storeyId: number, op: RoomCommand): Promise<RoomCommandResult> {
      const prepared = await prepareRoomCommand(modelId, storeyId, op);
      try { return prepared.commit(); } finally { prepared.dispose(); }
    },
    /** Model-close/backend-dispose releases retained native handles and invalidates prepared approvals. */
    disposeRooms(): void { generation++; host.layouts.clear(); modelStores.clear(); preparations.clear(); },
  };
}
