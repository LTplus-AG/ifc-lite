/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';

const uploadFields: readonly (keyof MeshData)[] = [
  'expressId', 'modelIndex', 'geometryItemId', 'materialId', 'occurrenceKey',
  'ifcType', 'geometryClass', 'positions', 'normals', 'indices', 'entityIds',
  'origin', 'material', 'uvs', 'texture', 'textureRef', 'textureBitmap', 'appearanceSource',
];

/** Federation rebuilds wrapper objects when a mesh-less model joins (#6953).
 * Those wrappers still describe the same upload. Buffer/reference identity
 * detects immutable replacement without hashing vertices; in-place changes
 * continue to use geometryContentVersion. Colour-only changes use the
 * existing pendingMeshColorUpdates drain and do not replace geometry. */
export function sameMeshUpload(a: MeshData | undefined, b: MeshData): boolean {
  if (a === b) return true;
  if (!a) return false;
  for (const field of uploadFields) if (a[field] !== b[field]) return false;
  return true;
}
