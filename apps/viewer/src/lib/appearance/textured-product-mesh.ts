/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { totalYupOffset } from '@/hooks/ingest/federationAlign';
import { placementFrameCoordinateInfo } from '@/lib/model-placement/persistence';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { toRenderTranslation } from '@/lib/model-placement/translation';
import type { TexturedProductPlan } from './textured-product-types';

/** Keep local f32 vertices local; reconstruct native RTC + origin in f64 once. */
export function texturedProductMesh(state: ViewerState, modelId: string, plan: TexturedProductPlan, bitmap: ImageBitmap): MeshData {
  const { mesh } = plan;
  if (plan.coordinateSpace !== 'ifc-z-up' || mesh.express_id !== plan.objectId
    || mesh.geometry_item_id !== plan.geometryItemId || !mesh.uvs.length) throw new Error('Invalid native annotation geometry.');
  const convert = (values: number[]) => {
    const result = new Float32Array(values.length);
    for (let i = 0; i < values.length; i += 3) result.set(toRenderTranslation([values[i], values[i + 1], values[i + 2]]), i);
    return result;
  };
  const nativeOrigin = mesh.origin ?? [0, 0, 0];
  const origin = toRenderTranslation([nativeOrigin[0] + plan.rtcOffset[0], nativeOrigin[1] + plan.rtcOffset[1], nativeOrigin[2] + plan.rtcOffset[2]]);
  const offset = totalYupOffset(placementFrameCoordinateInfo(state));
  origin[0] -= offset.x; origin[1] -= offset.y; origin[2] -= offset.z;
  const indices = new Uint32Array(mesh.indices);
  return { expressId: state.toGlobalId(modelId, plan.objectId),
    geometryItemId: state.toGlobalId(modelId, plan.geometryItemId),
    modelIndex: modelIndices(state.models).get(modelId),
    positions: convert(mesh.positions), normals: convert(mesh.normals), indices,
    uvs: new Float32Array(mesh.uvs), color: [...mesh.color], origin,
    appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices },
    textureBitmap: bitmap,
    textureRef: { textureId: state.toGlobalId(modelId, mesh.texture.texture_id), url: mesh.texture.url,
      repeatS: mesh.texture.repeat_s, repeatT: mesh.texture.repeat_t } };
}
