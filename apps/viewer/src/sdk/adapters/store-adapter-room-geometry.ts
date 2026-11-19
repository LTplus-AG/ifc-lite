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
  // Even without edits, source containment may name a storey absent from the
  // displayed hierarchy. Read canonical source edges, never infer emptiness.
  const options = {
    relationships: view ? effectiveMutationRelationships(store,view)
      : {relationships:[],supersededSourceIds:new Set<number>()},
    isDeleted: (id: number) => view?.isDeleted(id) ?? false,
    typeName: (id: number) => effectiveContextType(store,view ?? null,id),
  };
  let count = 0;
  for (const {expressId} of iterateEffectiveEntityIds(store,view,['IfcWall','IfcWallStandardCase'])) {
    if (++count > 200000) return 'The loaded model is too large for complete native wall coverage';
    if (effectiveStoreyId(store,expressId,options) === storeyId) required.add(expressId);
  }
  for (const mesh of model.geometryResult.meshes) {
    if (mesh.ifcType !== 'IfcWall' && mesh.ifcType !== 'IfcWallStandardCase') continue;
    const ref = state.resolveGlobalIdFromModels(mesh.expressId);
    if (ref?.modelId !== modelId || !required.has(ref.expressId)) continue;
    if (mesh.positions.length >= 9 && mesh.positions.length % 3 === 0 && mesh.indices.length >= 3
      && mesh.indices.length % 3 === 0 && mesh.positions.every(Number.isFinite)
      && mesh.indices.every(index => Number.isInteger(index) && index >= 0 && index < mesh.positions.length / 3)) required.delete(ref.expressId);
  }
  return required.size ? `Native geometry is unavailable for ${required.size} current storey wall(s)` : null;
}

function captureRoomGeometry(state:ViewerState,modelId:string,storeyId:number) {
  const model=state.models.get(modelId),plane=buildStoreyWorkplane(state,modelId,storeyId,0);
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
  return {ids:JSON.stringify([...ids].sort((a,b)=>a-b)),frame,meshes};
}
type RoomGeometryCapture = ReturnType<typeof captureRoomGeometry>;
/** What the lease and its probe both compare, so they cannot disagree on it: the frame, the storey's room ids, and
 * each room mesh in order by id, type, origin and buffer lengths. */
function roomGeometryLayout({ids,frame,meshes}:RoomGeometryCapture) {
  const slots=meshes.map(mesh=>({id:mesh.expressId,type:mesh.ifcType,origin:JSON.stringify(mesh.origin),positions:mesh.positions.length,indices:mesh.indices.length}));
  return (now:RoomGeometryCapture)=>now.frame===frame && now.ids===ids && now.meshes.length===slots.length
    && slots.every((slot,i)=>{const mesh=now.meshes[i];return mesh.expressId===slot.id && mesh.ifcType===slot.type && JSON.stringify(mesh.origin)===slot.origin
      && mesh.positions.length===slot.positions && mesh.indices.length===slot.indices;});
}

/** Exact native input bytes and frame: a later remesh may replace buffers without changing geometry. `validate` and
 * its cheap probe `current` run one check, `holds`, so they cannot disagree on frame, room ids, mesh order, ids, types,
 * origins or bytes. The probe alone may skip comparing bytes of a slot whose buffers are the ones last compared and
 * whose geometry content version has not moved (in-place vertex edits bump it); buffers a remesh replaced with
 * identical bytes are compared once, then adopted, so a remesh does not read as a change. */
export function roomGeometryLease(get:()=>ViewerState,modelId:string,storeyId:number):{validate():void;current():boolean} {
  const before=captureRoomGeometry(get(),modelId,storeyId),sameLayout=roomGeometryLayout(before);
  const saved=before.meshes.map(mesh=>({positions:mesh.positions.slice(),indices:mesh.indices.slice()}));
  let content=get().geometryContentVersion;
  let compared=before.meshes.map(mesh=>[new WeakRef(mesh.positions),new WeakRef(mesh.indices)] as const);
  const holds=(state:ViewerState,exact:boolean)=> {
    const now=captureRoomGeometry(state,modelId,storeyId);
    if (!sameLayout(now)) return false;
    const unmoved=!exact && state.geometryContentVersion===content;
    const ok=saved.every((mesh,i)=> {const current=now.meshes[i];
      if (unmoved && compared[i][0].deref()===current.positions && compared[i][1].deref()===current.indices) return true;
      return !mesh.positions.some((value,j)=>!Object.is(value,current.positions[j])) && !mesh.indices.some((value,j)=>value!==current.indices[j]);});
    if (ok) { content=state.geometryContentVersion; compared=now.meshes.map(mesh=>[new WeakRef(mesh.positions),new WeakRef(mesh.indices)] as const); }
    return ok;
  };
  return {
    validate:()=>{ if (!holds(get(),true)) throw new Error('The native Room geometry or model/storey frame changed; prepare again'); },
    current:()=>{ try { return holds(get(),false); } catch { return false; } }, // geometry the lease cannot read is changed geometry
  };
}
