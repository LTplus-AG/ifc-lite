/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { totalYupOffset } from '@/hooks/ingest/federationAlign';
import { placementFrameCoordinateInfo } from '@/lib/model-placement/persistence';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { toRenderTranslation } from '@/lib/model-placement/translation';

/** Native local f32 coordinates stay local; restore source origin/RTC in f64. */
export function nativeMeshFrame(state: ViewerState, modelId: string, positions: readonly number[],
  normals: readonly number[], nativeOrigin: readonly [number, number, number], rtc: readonly [number, number, number]) {
  const modelIndex = modelIndices(state.models).get(modelId);
  if (modelIndex === undefined) throw new Error('The native geometry model is no longer loaded.');
  const convert = (values: readonly number[]) => {
    const result = new Float32Array(values.length);
    for (let i = 0; i < values.length; i += 3) result.set(toRenderTranslation([values[i], values[i + 1], values[i + 2]]), i);
    return result;
  };
  const origin = toRenderTranslation([nativeOrigin[0] + rtc[0], nativeOrigin[1] + rtc[1], nativeOrigin[2] + rtc[2]]);
  const offset = totalYupOffset(placementFrameCoordinateInfo(state));
  origin[0] -= offset.x; origin[1] -= offset.y; origin[2] -= offset.z;
  if (!origin.every(Number.isFinite)) throw new Error('Native geometry has an invalid workspace frame.');
  return { positions: convert(positions), normals: convert(normals), origin, modelIndex };
}
