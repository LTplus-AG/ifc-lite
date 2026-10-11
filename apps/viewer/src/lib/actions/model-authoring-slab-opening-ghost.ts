/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { applyFrame, refId } from '../../../../../packages/create/src/in-store/host-geometry-frame';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { prismGhostMesh } from '@/lib/commands/modeling/ghost-shapes';
import type { ViewerState } from '@/store';
import type { AuthoringRow } from './model-authoring-preview';
import { authoringReader } from './model-authoring-read';

/** Actual native cutter bounds on the existing storey workplane; this is
 * neither a boolean result nor a claim of footprint fit or overlap. */
export function authoringSlabOpeningGhost(state: ViewerState, row: AuthoringRow, rows: readonly AuthoringRow[], id: number): MeshData | null {
  const native=row.resolved.slabOpening;
  if (!native || !row.modelId || row.op.op!=='hosted.create' || !('params' in row.op)) return null;
  if(rows.some(other=>other.index<row.index && other.modelId===row.modelId && (other.op.op==='element.move'||other.op.op==='element.rotate')))return null;
  const reader=authoringReader(state,row.modelId);if(!reader)return null;
  const {snapshot,bounds}=native,frame=snapshot.placement.frame;
  const storey=effectiveMetadataRecord(reader.dataStore,snapshot.storeyId,reader.view);
  // Native host-local XY can be projected only when its immediate parent is
  // this storey and its extrusion is upright. Other frames stay authorable,
  // but cannot be presented as an accurate planar cutter preview.
  if(!storey || snapshot.placement.parent!==refId(storey.attributes[5])
    || Math.abs(frame.z[0])>1e-9 || Math.abs(frame.z[1])>1e-9 || Math.abs(frame.z[2]-1)>1e-9)return null;
  const plane=buildStoreyWorkplane(state,row.modelId,snapshot.storeyId,0);if(!isWorkplane(plane))return null;
  const bottom=applyFrame(frame,[bounds.min[0],bounds.min[1],bounds.min[2]])[2];
  const top=applyFrame(frame,[bounds.min[0],bounds.min[1],bounds.max[2]])[2];
  const outline: [number,number][] = [[bounds.min[0],bounds.min[1]],[bounds.max[0],bounds.min[1]],[bounds.max[0],bounds.max[1]],[bounds.min[0],bounds.max[1]]].map(([x,y])=>{
    const p=applyFrame(frame,[x,y,0]);return [p[0],p[1]];
  });
  return prismGhostMesh(plane,outline,bottom,top,id);
}
