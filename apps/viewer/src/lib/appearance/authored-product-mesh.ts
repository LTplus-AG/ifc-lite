/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { nativeMeshFrame } from './native-mesh-frame';
import type { AuthoredProductPlan, AuthoredProductMesh } from './authored-product-types';

/** Keep local f32 vertices local; reconstruct native RTC + origin in f64 once. */
export function authoredProductMesh(state: ViewerState, modelId: string, plan: AuthoredProductPlan, mesh: AuthoredProductMesh, bitmap?: ImageBitmap): MeshData {
  const vertices = mesh.positions.length / 3;
  if (!vertices || !Number.isInteger(vertices) || mesh.normals.length !== mesh.positions.length
    || !mesh.indices.length || mesh.indices.length % 3 || mesh.indices.some(index => !Number.isInteger(index) || index < 0 || index >= vertices)
    || mesh.positions.some(value => !Number.isFinite(value)) || mesh.normals.some(value => !Number.isFinite(value))
    || (mesh.uvs && (mesh.uvs.length !== vertices * 2 || mesh.uvs.some(value => !Number.isFinite(value))))
    || plan.coordinateSpace !== 'ifc-z-up' || mesh.express_id !== plan.objectId
    || !Number.isSafeInteger(mesh.geometry_item_id) || mesh.geometry_item_id <= 0
    || (!!mesh.texture !== !!bitmap) || (!!mesh.texture !== !!mesh.uvs?.length)) throw new Error('Invalid native annotation geometry.');
  const indices = new Uint32Array(mesh.indices);
  return { expressId: state.toGlobalId(modelId, plan.objectId),
    geometryItemId: state.toGlobalId(modelId, mesh.geometry_item_id),
    ...nativeMeshFrame(state, modelId, mesh.positions, mesh.normals, mesh.origin ?? [0, 0, 0], plan.rtcOffset), indices,
    color: [...mesh.color],
    appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices },
    ...(mesh.texture ? { uvs: new Float32Array(mesh.uvs!), textureBitmap: bitmap,
    textureRef: { textureId: state.toGlobalId(modelId, mesh.texture.texture_id), url: mesh.texture.url,
      repeatS: mesh.texture.repeat_s, repeatT: mesh.texture.repeat_t } } : {}) };
}
