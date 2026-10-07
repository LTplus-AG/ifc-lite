/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';

/** Federation rebuilds wrapper objects when a mesh-less model joins (#6953).
 * Those wrappers still describe the same upload. Buffer/reference identity
 * detects immutable replacement without hashing vertices; in-place changes
 * continue to use geometryContentVersion. */
export function sameMeshUpload(a: MeshData | undefined, b: MeshData): boolean {
  return a === b || !!a &&
    a.expressId === b.expressId && a.modelIndex === b.modelIndex &&
    a.geometryItemId === b.geometryItemId && a.materialId === b.materialId &&
    a.occurrenceKey === b.occurrenceKey && a.ifcType === b.ifcType &&
    a.geometryClass === b.geometryClass && a.positions === b.positions &&
    a.normals === b.normals && a.indices === b.indices &&
    a.entityIds === b.entityIds && a.color === b.color &&
    a.origin === b.origin && a.material === b.material &&
    a.uvs === b.uvs && a.texture === b.texture &&
    a.textureRef === b.textureRef && a.textureBitmap === b.textureBitmap &&
    a.appearanceSource === b.appearanceSource;
}
