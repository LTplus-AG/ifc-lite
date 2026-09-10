/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import type { AppearancePreviewParts } from './preview.js';

export function geometryWithAppearance(modelId: string, groups: readonly AppearancePreviewParts[], renderer: Renderer) {
  const model = useViewerStore.getState().models.get(modelId);
  if (!model?.geometryResult) throw new Error('The target model is no longer loaded.');
  const byOwner = new Map(groups.map(group => [group.globalId, group]));
  const sourceParts = (group: AppearancePreviewParts) => group.instanced ? [] : group.parts.map(part =>
    ({ ...(renderer.getScene().appearanceSourceMesh?.(part) ?? part) }));
  const found = new Set<number>();
  let triangleDelta = 0, vertexDelta = 0;
  const meshes = model.geometryResult.meshes.flatMap(mesh => {
    if (mesh.entityIds?.some(id => byOwner.has(id))) {
      throw new Error('This combined geometry needs to be separated before applying appearance.');
    }
    const group = byOwner.get(mesh.expressId);
    if (!group) return [mesh];
    triangleDelta -= mesh.indices.length / 3;
    vertexDelta -= mesh.positions.length / 3;
    if (found.has(mesh.expressId)) return [];
    found.add(mesh.expressId);
    const parts = sourceParts(group);
    for (const part of parts) {
      triangleDelta += part.indices.length / 3;
      vertexDelta += part.positions.length / 3;
    }
    // History wrappers are frozen snapshots; live model meshes must remain
    // mutable for the existing CPU release/transform paths.
    return parts.map(part => ({ ...part }));
  });
  for (const group of groups) {
    if (found.has(group.globalId)) continue;
    if (!group.materializedOriginals?.length && !group.companionOriginals?.length) throw new Error('Some target geometry is no longer in the model. Refresh the appearance preview.');
    // The loader's totals count its retained flat mesh list, not instance templates.
    // Materialization inserts one flat occurrence; Undo removes it again.
    for (const part of sourceParts(group)) {
      meshes.push(part); triangleDelta += part.indices.length / 3; vertexDelta += part.positions.length / 3;
    }
  }
  return { ...model.geometryResult, meshes,
    totalTriangles: model.geometryResult.totalTriangles + triangleDelta,
    totalVertices: model.geometryResult.totalVertices + vertexDelta };
}
