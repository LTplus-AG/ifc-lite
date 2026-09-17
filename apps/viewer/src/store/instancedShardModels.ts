/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which models have ever handed GPU-instanced (IFNS) shards to the renderer.
 *
 * The shards are drained into renderer-owned buffers and are not kept on the
 * model, and the geometry-side signals (`instancedGeometryAabbs`, class-2
 * templates) can be absent while instances exist, e.g. an instanced entity
 * whose AABB was not finite is left out of the box map. Code that must not move
 * a model's flat meshes without its instances (the federation RTC convergence,
 * #4897) asks here. Model ids are never reused, so entries are never removed.
 */

const models = new Set<string>();

export function noteInstancedShardModel(modelId: string): void {
  models.add(modelId);
}

export function hasInstancedShards(modelId: string): boolean {
  return models.has(modelId);
}
