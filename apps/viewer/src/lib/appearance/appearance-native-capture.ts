/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
/** Stable source-piece ordinals, shared by CapturePanel and operation discovery. */
export function nativeCapturedSurfaces(models: ViewerState['models']) {
  return [...models.values()].flatMap((model) =>
    (model.geometryResult?.meshes ?? []).flatMap((mesh, ordinal) =>
      mesh.textureRef
        ? [{ id: `${model.id}:${ordinal}`, modelId: model.id, modelName: model.name, ordinal, mesh }]
        : [],
    ),
  );
}
