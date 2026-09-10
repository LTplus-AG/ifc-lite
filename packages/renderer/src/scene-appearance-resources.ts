/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { TexturedMesh } from './scene.js';
import type { SceneAppearanceAccess } from './scene-appearance-preview.js';
import type { AppearanceBuckets, FlatAppearanceResource } from './scene-appearance-buckets.js';

export type AppearanceResource = { kind: 'textured'; mesh: TexturedMesh }
  | { kind: 'flat'; flat: FlatAppearanceResource };
export const textured = (part: MeshData) =>
  !!(part.uvs && (part.texture || (part.textureRef && part.textureBitmap)));
export function releaseAppearanceResources(access: SceneAppearanceAccess, buckets: AppearanceBuckets,
  resources: readonly AppearanceResource[]): void {
  for (const resource of resources) {
    try {
      if (resource.kind === 'textured') access.release(resource.mesh);
      else buckets.release(resource.flat);
    } catch (error) { console.warn('[Appearance] resource disposal failed', error); }
  }
}
/** Allocate every colour bucket and texture, retaining no live scene membership. */
export function stageAppearanceResources(access: SceneAppearanceAccess, buckets: AppearanceBuckets,
  parts: readonly MeshData[]): AppearanceResource[] {
  const meshes = access.meshes(), start = meshes.length;
  const resources: AppearanceResource[] = [];
  try {
    const flatIndices: number[] = [];
    parts.forEach((part, index) => {
      if (textured(part)) {
        const before = meshes.length;
        access.upload(part);
        if (meshes.length !== before + 1) throw new Error('The new textured geometry is invalid.');
      } else flatIndices.push(index);
    });
    resources.push(...meshes.splice(start).map(mesh => ({ kind: 'textured' as const, mesh })));
    resources.push(...buckets.stage(parts, flatIndices).map(flat => ({ kind: 'flat' as const, flat })));
    return resources;
  } catch (error) {
    resources.push(...meshes.splice(start).map(mesh => ({ kind: 'textured' as const, mesh })));
    releaseAppearanceResources(access, buckets, resources);
    throw error;
  }
}
