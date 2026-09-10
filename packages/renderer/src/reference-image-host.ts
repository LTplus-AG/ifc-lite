/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from './index.js';
import { ReferenceImageManager } from './reference-images.js';

/** Reuse the renderer camera and scene raycast, including occurrence placement. */
export function createReferenceImageManager(renderer: Renderer): ReferenceImageManager {
  return new ReferenceImageManager({
    requestRender: () => renderer.requestRender(),
    ray: (x, y) => {
      if (renderer.isDeviceLost()) return null;
      const canvas = renderer.getCanvas(), rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
      return renderer.getCamera().unprojectToRay(x * canvas.width / rect.width, y * canvas.height / rect.height, canvas.width, canvas.height);
    },
    sceneDistance: async (x, y, ray, options) => {
      const picked = await renderer.pick(x, y, options);
      if (!picked) return Infinity;
      if (picked.worldXYZ) return Math.hypot(picked.worldXYZ.x-ray.origin.x, picked.worldXYZ.y-ray.origin.y, picked.worldXYZ.z-ray.origin.z);
      // Existing large-model CPU fallback can omit depth. Restrict its precise
      // raycast to the canonical selected owner, never hidden unrelated geometry.
      return renderer.raycastScene(x, y, { ...options, isolatedIds: new Set([picked.expressId]) })?.intersection.distance ?? 0;
    },
  });
}
