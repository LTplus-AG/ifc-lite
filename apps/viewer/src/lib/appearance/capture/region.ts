/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type ViewerState } from '@/store';
import { totalYupOffset } from '@/hooks/ingest/federationAlign';
import { placementFrameCoordinateInfo, placementFrameKey } from '@/lib/model-placement/persistence';
import { placementFor } from '@/lib/model-placement/state';
import { fromRenderTranslation, type Translation } from '@/lib/model-placement/translation';
import type { CapturedMeshRequest } from '../planner-types';

// Match the native captured planner's row limit; no reconstruction or welding.
const MAX_ROWS = 200_000;
export interface CaptureRegistration {
  readonly source: MeshData;
  readonly frameKey: string;
  readonly renderOffset: Readonly<{ x: number; y: number; z: number }>;
  readonly modelTranslationIfc: Translation;
  validate(): void;
}

/** Raw loaded model geometry only. A placedViewGeometry copy would apply the
 * committed placement twice. The callback fences asynchronous authoring against
 * unload, realignment, source replacement and placement changes. */
export function captureRegistration(modelId: string, mesh: MeshData,
  getState: () => ViewerState = useViewerStore.getState): CaptureRegistration {
  const initial = getState(), model = initial.models.get(modelId), geometry = model?.geometryResult;
  if (!geometry?.meshes.includes(mesh)) throw new Error('Choose a surface from the raw loaded model geometry.');
  if (initial.modelPlacement.preview) throw new Error('Finish model repositioning before capturing a surface.');
  const frameKey = placementFrameKey(initial);
  const renderOffset = Object.freeze(totalYupOffset(placementFrameCoordinateInfo(initial)));
  const modelTranslationIfc = Object.freeze([...placementFor(initial.modelPlacement, modelId).translation]) as Translation;
  const positions = mesh.positions, indices = mesh.indices, uvs = mesh.uvs, textureRef = mesh.textureRef;
  const origin = mesh.origin?.slice(), color = [...mesh.color], sampler = textureRef && { ...textureRef };
  const validate = () => {
    const state = getState(), current = state.models.get(modelId);
    const offset = totalYupOffset(placementFrameCoordinateInfo(state));
    if (current !== model || current?.geometryResult !== geometry || !geometry.meshes.includes(mesh)
      || state.modelPlacement.preview
      || placementFrameKey(state) !== frameKey
      || !placementFor(state.modelPlacement, modelId).translation.every((v, i) => v === modelTranslationIfc[i])
      || offset.x !== renderOffset.x || offset.y !== renderOffset.y || offset.z !== renderOffset.z
      || !mesh.color.every((v, i) => v === color[i])
      || (sampler && (mesh.textureRef?.url !== sampler.url || mesh.textureRef.textureId !== sampler.textureId
        || mesh.textureRef.repeatS !== sampler.repeatS || mesh.textureRef.repeatT !== sampler.repeatT))
      || mesh.positions !== positions || mesh.indices !== indices || mesh.uvs !== uvs || mesh.textureRef !== textureRef
      || (origin ? !mesh.origin?.every((v, i) => v === origin[i]) : mesh.origin !== undefined)) {
      throw new Error('The captured surface or workspace registration changed. Choose the region again.');
    }
  };
  return Object.freeze({ source: mesh, frameKey, renderOffset, modelTranslationIfc, validate });
}

/** Explicit zero-based triangle ordinals from one textured raw mesh. Original
 * vertex identity is retained across coincident UV seams. Returned coordinates
 * are workspace IFC Z-up metres; GPU V is converted to IFC V exactly once. */
export function captureRegion(mesh: MeshData, triangleIds: readonly number[], registration: CaptureRegistration): {
  mesh: CapturedMeshRequest['mesh']; textureRef: NonNullable<MeshData['textureRef']>;
} {
  registration.validate();
  if (registration.source !== mesh) throw new Error('The registration belongs to another captured surface.');
  if (!mesh.textureRef || mesh.texture) throw new Error('The captured surface needs one external image texture.');
  if (mesh.color.some(value => Math.fround(value) !== 1)) throw new Error('Bake the material tint and opacity into the image before IFC capture.');
  if ((mesh.geometryClass ?? 0) === 2 || mesh.entityIds) throw new Error('Choose one concrete surface occurrence.');
  if (triangleIds.length === 0 || triangleIds.length > MAX_ROWS) throw new Error('Select a smaller region with 1–200,000 triangles.');
  const vertexCount = mesh.positions.length / 3;
  if (!Number.isInteger(vertexCount) || mesh.indices.length % 3 || mesh.uvs?.length !== vertexCount * 2) {
    throw new Error('Captured geometry needs complete positions, triangles and per-vertex image coordinates.');
  }
  const positions: CapturedMeshRequest['mesh']['positions'] = [], uvs: CapturedMeshRequest['mesh']['uvs'] = [];
  const triangles: CapturedMeshRequest['mesh']['triangles'] = [];
  const remap = new Map<number, number>(), selected = new Set<number>();
  const origin = mesh.origin ?? [0, 0, 0], offset = registration.renderOffset;
  const vertex = (id: number): number => {
    if (!Number.isInteger(id) || id < 0 || id >= vertexCount) throw new Error('Captured triangle vertex is out of bounds.');
    const prior = remap.get(id); if (prior !== undefined) return prior;
    if (positions.length >= MAX_ROWS) throw new Error('Select a smaller region with at most 200,000 vertices.');
    const p = fromRenderTranslation({ x: mesh.positions[id * 3] + origin[0] + offset.x,
      y: mesh.positions[id * 3 + 1] + origin[1] + offset.y, z: mesh.positions[id * 3 + 2] + origin[2] + offset.z });
    const world: [number, number, number] = [p[0] + registration.modelTranslationIfc[0],
      p[1] + registration.modelTranslationIfc[1], p[2] + registration.modelTranslationIfc[2]];
    const uv: [number, number] = [mesh.uvs![id * 2], 1 - mesh.uvs![id * 2 + 1]];
    if (!world.every(v => Number.isFinite(v) && Math.abs(v) <= 1e9)) throw new Error('Captured coordinates must be finite world metres within +/-1e9.');
    if (!uv.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Captured UVs must stay within the non-repeating image [0,1].');
    const next = positions.length; positions.push(world); uvs.push(uv); remap.set(id, next); return next;
  };
  for (const id of triangleIds) {
    if (!Number.isInteger(id) || id < 0 || id >= mesh.indices.length / 3) throw new Error('Captured triangle selection is out of bounds.');
    if (selected.has(id)) throw new Error('A captured triangle may only be selected once.');
    selected.add(id);
    triangles.push([vertex(mesh.indices[id * 3]), vertex(mesh.indices[id * 3 + 1]), vertex(mesh.indices[id * 3 + 2])]);
  }
  registration.validate();
  return { mesh: { positions, triangles, uvs, uvTriangles: triangles.map(face => [...face]) }, textureRef: { ...mesh.textureRef } };
}
