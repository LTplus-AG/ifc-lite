/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '@/store';
import { liveEntityConforms } from '@ifc-lite/create';
import { effectiveStoreyId } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { effectiveMutationRelationships } from './query-overlay-relations';
import { effectiveContextType } from '@/components/viewer/EntityContextMenu.effective-selection';
import { buildStoreyWorkplane } from '@/lib/commands/modeling/workplane';
import { storeyRoomGeometryIds } from '@/lib/rooms/storey-rooms';
import type { Workplane } from '@/lib/commands/modeling/types';

/** A successful remesh can still omit a live wall with no Representation.
 * Native containment is authoritative; an empty mesh list is not noWalls. */
export function missingRoomWallGeometry(state: ViewerState, modelId: string, storeyId: number, plane: Workplane): string | null {
  const model = state.models.get(modelId), store = model?.ifcDataStore;
  if (!store || !model.geometryResult) return 'Current native wall geometry is unavailable';
  const view = state.mutationViews.get(modelId);
  const required = new Set(storeyRoomGeometryIds(state,modelId,storeyId,plane)
    .filter(id => liveEntityConforms(store,id,'IfcWall',view)));
  const options = view ? {
    relationships: effectiveMutationRelationships(store,view),
    isDeleted: (id: number) => view.isDeleted(id),
    typeName: (id: number) => effectiveContextType(store,view,id),
  } : undefined;
  let count = 0;
  for (const {expressId} of iterateEffectiveEntityIds(store,view,['IfcWall','IfcWallStandardCase'])) {
    if (++count > 200000) return 'The loaded model is too large for complete native wall coverage';
    if (effectiveStoreyId(store,expressId,options) === storeyId) required.add(expressId);
  }
  for (const mesh of model.geometryResult.meshes) {
    const ref = state.resolveGlobalIdFromModels(mesh.expressId);
    if (ref?.modelId !== modelId || !required.has(ref.expressId)) continue;
    if (mesh.positions.length >= 9 && mesh.positions.length % 3 === 0 && mesh.indices.length >= 3
      && mesh.indices.length % 3 === 0 && mesh.positions.every(Number.isFinite)
      && mesh.indices.every(index => Number.isInteger(index) && index >= 0 && index < mesh.positions.length / 3)) required.delete(ref.expressId);
  }
  return required.size ? `Native geometry is unavailable for ${required.size} current storey wall(s)` : null;
}

/** Exact native input bytes and frame: a later remesh may replace buffers without changing geometry. */
export function roomGeometryLease(get:()=>ViewerState,modelId:string,storeyId:number):()=>void {
  const capture = () => {
    const state=get(),model=state.models.get(modelId),plane=buildStoreyWorkplane(state,modelId,storeyId,0);
    if (!model?.geometryResult || 'refused' in plane) throw new Error('The current native Room geometry/frame is unavailable');
    const missing = missingRoomWallGeometry(state,modelId,storeyId,plane);
    if (missing) throw new Error(missing);
    const ids=new Set(storeyRoomGeometryIds(state,modelId,storeyId,plane));
    const meshes=model.geometryResult.meshes.filter(mesh=> {
      const ref=state.resolveGlobalIdFromModels(mesh.expressId);
      return ref?.modelId===modelId && ids.has(ref.expressId);
    });
    if (meshes.reduce((n,mesh)=>n+mesh.positions.length+mesh.indices.length,0)>10000000) throw new Error('Native Room geometry exceeds the complete review input limit');
    const frame=JSON.stringify({basis:[[0,0,0],[1,0,0],[0,1,0],[0,0,1]].map(point=>plane.localToRender(point as [number,number,number])),coordinateInfo:model.geometryResult.coordinateInfo});
    return {ids:[...ids].sort((a,b)=>a-b),frame,meshes};
  };
  const before=capture();
  const saved=before.meshes.map(mesh=>({id:mesh.expressId,type:mesh.ifcType,origin:JSON.stringify(mesh.origin),positions:mesh.positions.slice(),indices:mesh.indices.slice()}));
  return ()=> {
    const now=capture();
    if (now.frame!==before.frame || JSON.stringify(now.ids)!==JSON.stringify(before.ids) || now.meshes.length!==saved.length
      || saved.some((mesh,i)=> {const current=now.meshes[i];return current.expressId!==mesh.id || current.ifcType!==mesh.type || JSON.stringify(current.origin)!==mesh.origin
        || current.positions.length!==mesh.positions.length || current.indices.length!==mesh.indices.length
        || mesh.positions.some((value,j)=>!Object.is(value,current.positions[j])) || mesh.indices.some((value,j)=>value!==current.indices[j]);})) {
      throw new Error('The native Room geometry or model/storey frame changed; prepare again');
    }
  };
}
