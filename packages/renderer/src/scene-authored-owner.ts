/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { SceneAppearanceAccess } from './scene-appearance-preview.js';
import type { AppearanceBuckets } from './scene-appearance-buckets.js';
import { releaseAppearanceResources, stageAppearanceResources, textured } from './scene-appearance-resources.js';

function validateParts(parts: readonly MeshData[]): void {
  if (!parts.length) throw new Error('A new owner requires geometry.');
  const owner = parts[0];
  for (const part of parts) {
    const vertices = part.positions.length / 3;
    if (part.expressId !== owner.expressId || (part.modelIndex ?? 0) !== (owner.modelIndex ?? 0)
      || part.entityIds || !Number.isSafeInteger(part.expressId) || part.expressId <= 0
      || !vertices || !Number.isInteger(vertices) || part.normals.length !== part.positions.length
      || !part.indices.length || part.indices.length % 3
      || part.indices.some(index => index >= vertices)
      || part.positions.some(value => !Number.isFinite(value)) || part.normals.some(value => !Number.isFinite(value))
      || part.color.length !== 4 || part.color.some(value => !Number.isFinite(value) || value < 0 || value > 1)
      || (part.origin && (part.origin.length !== 3 || part.origin.some(value => !Number.isFinite(value))))) {
      throw new Error('A new owner requires valid geometry parts with one model and object identity.');
    }
    if ((part.texture || part.textureRef || part.textureBitmap || part.uvs) && (!textured(part)
      || part.uvs!.length !== vertices * 2 || part.uvs!.some(value => !Number.isFinite(value)))) {
      throw new Error('Textured geometry requires a retained image and complete UV coordinates.');
    }
  }
}

/** Detached allocation followed by one synchronous publication; disposal never removes a committed owner. */
export function prepareSceneAuthoredOwner(access: SceneAppearanceAccess, buckets: AppearanceBuckets,
  input: readonly MeshData[], validateScene: () => void) {
  validateParts(input);
  const id = input[0].expressId;
  const vacant = () => {
    validateScene();
    if (access.data.has(id) || access.instances.has(id)) throw new Error('The new geometry owner already exists or was claimed while preparing.');
  };
  vacant();
  // Own the wrappers; position/normal/index buffers remain borrowed immutable inputs.
  const parts = input.map(part => access.adopt({ ...part, color: [...part.color], origin: part.origin && [...part.origin] }));
  const origins = parts.map(part => [...(part.origin ?? [0, 0, 0])]);
  const resources = stageAppearanceResources(access, buckets, parts);
  const flatParts = resources.map(resource => resource.kind === 'flat'
    ? resource.flat.partIndices.map(index => parts[index]) : undefined);
  let committed = false, disposed = false;
  return {
    commit() {
      if (disposed) throw new Error('The prepared geometry was released.');
      if (committed) return;
      vacant();
      for (const [index, part] of parts.entries()) {
        const current = access.adopt(part);
        if ((current.origin ?? [0, 0, 0]).some((value, axis) => value !== origins[index][axis])) {
          throw new Error('The model placement changed while preparing the object.');
        }
      }
      resources.forEach((resource, index) => {
        if (resource.kind === 'textured') access.meshes().push(resource.mesh);
        else buckets.attach(resource.flat, flatParts[index]!);
      });
      access.data.set(id, parts);
      buckets.refresh();
      access.invalidate(id);
      committed = true;
    },
    dispose() {
      if (disposed || committed) return;
      disposed = true;
      releaseAppearanceResources(access, buckets, resources);
    },
  };
}
