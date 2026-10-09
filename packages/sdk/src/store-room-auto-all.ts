/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { effectiveStoreyIds, filterRoomFaces, roomCandidatesFromFaces, planRoomCreation, createRoomsInStore, occupancyTest, existingSpaceFootprintEntriesByStorey } from '@ifc-lite/create';
import { StoreEditor } from '@ifc-lite/mutations';
import type { CostStoreModelResolution } from './cost-store-backend.js';
import type { RoomCommand, RoomCommandHost, RoomCommandResult, RoomGeometryProvider, NativeRoomGeometry, PreparedRoomCommand } from './store-room-command.js';

/** Same native planner and writer, one detached graph and one recorded approval (#7324). */
export async function prepareAllStoreyRooms(
  model: CostStoreModelResolution, command: RoomCommand, provide: RoomGeometryProvider,
  host: RoomCommandHost, currentModel: () => CostStoreModelResolution,
): Promise<PreparedRoomCommand> {
  if (!model.store.schemaVersion || !['IFC2X3','IFC4','IFC4X3'].includes(model.store.schemaVersion)) throw new Error('Complete AutoAll requires a supported known IFC schema');
  const ids = effectiveStoreyIds(model.store, model.mutationView).sort((a,b)=>a-b);
  if (ids.length > 128) throw new Error('More than 128 storeys: complete AutoAll preparation is unavailable');
  const weld = command.weld ?? .05, minArea = command.minArea ?? .3;
  const existing = existingSpaceFootprintEntriesByStorey(model.store, model.mutationView);
  const rows: NonNullable<RoomCommandResult['storeys']>[number][] = [];
  const plans = new Map<number, ReturnType<typeof planRoomCreation>>();
  const geometries: NativeRoomGeometry[] = [];
  for (const storeyId of ids) {
    command.signal?.throwIfAborted();
    const geometry = await provide(model, storeyId);
    currentModel();
    geometries.push(geometry);
    if (geometry.unavailable) {
      rows.push({ storeyId, status:'unavailable', reason:geometry.unavailable, roomCount:null, candidates:[], created:[] });
      continue;
    }
    geometry.validate?.();
    const spaces = geometry.spaces ?? existing.get(storeyId) ?? [];
    if (geometry.walls.length === 0) {
      rows.push({storeyId,status:'noWalls',roomCount:spaces.length,candidates:[],created:[]});
      continue;
    }
    const occupied = geometry.occupied ?? occupancyTest(spaces.map(space=>space.footprint),[]);
    const entry = host.layouts.read(model.modelId,storeyId,weld,host.historyHead(model.modelId),geometry.walls.map(w=>w.corners),geometry.factory);
    const candidates = roomCandidatesFromFaces(filterRoomFaces(entry.faces,minArea),occupied,spaces);
    const previous = rows.flatMap(row=>row.candidates);
    const population = [...previous,...candidates];
    if (population.length>128 || population.reduce((n,face)=>n+face.centre.length+face.inner.length+face.outer.length,0)>4096) throw new Error('Complete AutoAll native candidates exceed the review population limit');
    if (population.some(face=>!Number.isFinite(face.grossArea) || !Number.isFinite(face.netArea) || [...face.centre,...face.inner,...face.outer].some(point=>point.some(value=>!Number.isFinite(value))))) throw new Error('Native AutoAll contours/areas are unavailable');
    const prepared = planRoomCreation(candidates,{action:'auto',boundary:command.boundary ?? 'inner',height:command.height ?? 3,z:command.z ?? 0,
      existingCount:spaces.length,namePattern:command.namePattern ?? 'Room {n}',
      ...(command.PredefinedType!==undefined?{PredefinedType:command.PredefinedType}:{}), ...(command.ObjectType!==undefined?{ObjectType:command.ObjectType}:{})});
    plans.set(storeyId,prepared);
    rows.push({storeyId,status:prepared.length?'ready':candidates.length?'occupied':'noFaces',roomCount:spaces.length,candidates:structuredClone(candidates),created:[]});
  }
  const layout = host.layouts.version();
  let disposed = false, committed = false;
  const validate = () => {
    if (disposed || committed) throw new Error('This AutoAll preparation is no longer available');
    currentModel();
    if (JSON.stringify(effectiveStoreyIds(model.store,model.mutationView).sort((a,b)=>a-b))!==JSON.stringify(ids)) throw new Error('The complete storey population changed');
    if (host.layouts.version()!==layout) throw new Error('The native Room layout changed');
    for (const geometry of geometries) geometry.validate?.();
  };
  validate();
  const write = (draft: CostStoreModelResolution): RoomCommandResult => {
    const coverage = rows.map(row=>({...row,created:(plans.get(row.storeyId)?.length?createRoomsInStore(draft.store,draft.editor,row.storeyId,plans.get(row.storeyId)!):[]).map(expressId=>({modelId:model.modelId,expressId}))}));
    return {created:coverage.flatMap(row=>row.created),updated:[],deleted:[],skipped:[],candidates:coverage.flatMap(row=>row.candidates),storeys:coverage};
  };
  // Unknown storeys must not authorize even the otherwise-known plans.
  const unavailable = rows.some(row=>row.status==='unavailable');
  const draft = model.mutationView.prepareAtomic(view=> {
    const preview = {...model,mutationView:view,editor:new StoreEditor(model.store,view)};
    const result = unavailable ? {created:[],updated:[],deleted:[],skipped:[],candidates:rows.flatMap(row=>row.candidates),storeys:rows} : write(preview);
    return {preview,result};
  });
  return {result:structuredClone(draft.result.result),preview:draft.result.preview,
    validate:()=>{validate();draft.validate();},
    commit:()=> {
      validate();draft.validate();
      if (unavailable) throw new Error('Some storeys are unavailable: complete AutoAll approval is refused');
      const result = draft.result.result.created.length ? host.record(model.modelId,write) : draft.result.result;
      committed=true;return structuredClone(result);
    },
    dispose:()=>{disposed=true;},
  };
}
