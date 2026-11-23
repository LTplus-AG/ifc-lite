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
 * #4897) asks here. The revision also lets spatial indexing detect shard
 * delivery that occurred while its React effect was remounting (#5275).
 * Model ids are never reused, so entries are never removed.
 */

const models = new Set<string>();
const revisions = new Map<string, number>();
let sinceReset = false;

export function noteInstancedShardModel(modelId: string): void {
  models.add(modelId);
  sinceReset = true;
  revisions.set(modelId, (revisions.get(modelId) ?? 0) + 1);
}

/** Every model that has handed shards to the renderer so far. */
export function instancedShardModelIds(): string[] { return [...models]; }

export function hasInstancedShards(modelId: string): boolean {
  return models.has(modelId);
}

/** Whether any shards were handed over since the last full reset (legacy single-model wiring registers no model to ask by id). */
export function anyInstancedShards(): boolean {
  return sinceReset;
}

/** A full queue reset (session reset, clear all): shards of an earlier load must not block a later one. */
export function forgetInstancedShardsBeforeReset(): void {
  sinceReset = false;
}

/** Monotonic across placement-hook remounts; a drained queue keeps no bytes. */
export function instancedShardRevision(modelId: string): number {
  return revisions.get(modelId) ?? 0;
}
