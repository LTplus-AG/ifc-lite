/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '@/store';
import { buildStoreyWorkplane } from '@/lib/commands/modeling/workplane';
import { storeyRoomGeometryIds } from '@/lib/rooms/storey-rooms';

/** Exact native input bytes and frame: a later remesh may replace buffers without changing geometry. */
export function roomGeometryLease(get:()=>ViewerState,modelId:string,storeyId:number):()=>void {
  const capture = () => {
    const state=get(),model=state.models.get(modelId),plane=buildStoreyWorkplane(state,modelId,storeyId,0);
    if (!model?.geometryResult || 'refused' in plane) throw new Error('The current native Room geometry/frame is unavailable');
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
