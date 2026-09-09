/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { nativeMeshFrame } from './native-mesh-frame';
import type { TexturedProductPlan } from './textured-product-types';

/** Keep local f32 vertices local; reconstruct native RTC + origin in f64 once. */
export function texturedProductMesh(state: ViewerState, modelId: string, plan: TexturedProductPlan, bitmap: ImageBitmap): MeshData {
  const { mesh } = plan;
  if (plan.coordinateSpace !== 'ifc-z-up' || mesh.express_id !== plan.objectId
    || mesh.geometry_item_id !== plan.geometryItemId || !mesh.uvs.length) throw new Error('Invalid native annotation geometry.');
  const indices = new Uint32Array(mesh.indices);
  return { expressId: state.toGlobalId(modelId, plan.objectId),
    geometryItemId: state.toGlobalId(modelId, plan.geometryItemId),
    ...nativeMeshFrame(state, modelId, mesh.positions, mesh.normals, mesh.origin ?? [0, 0, 0], plan.rtcOffset), indices,
    uvs: new Float32Array(mesh.uvs), color: [...mesh.color],
    appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices },
    textureBitmap: bitmap,
    textureRef: { textureId: state.toGlobalId(modelId, mesh.texture.texture_id), url: mesh.texture.url,
      repeatS: mesh.texture.repeat_s, repeatT: mesh.texture.repeat_t } };
}
