/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bucket each paged mesh would be in on the bucket path (its GROUP), and what that bucket's batch
 * would decide about it as a whole: compact-lod.ts takes those decisions for the pages.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { COMPACT_RECORD_BYTES, compactRow, compactStep, type CompactRef } from '@ifc-lite/geometry/compact';
import type { CompactPageDeps } from './compact-page-deps.js';
import type { CompactGeometryStore } from './compact-store.js';
import type { SceneCompactHost } from './scene-compact-host.js';
import { entityCollapses } from './compact-exact.js';

const ZERO_POSITION = new Float32Array(3);

/** The bucket a set of paged meshes would share. */
export interface Group {
  bounds: { min: [number, number, number]; max: [number, number, number] };
  triangles: number;
  /** A member is on a lattice finer than the bucket batch's (level 10 collapsed it). */
  fine: boolean;
  /** Why its meshes move to their bucket: the batch would stay exact f32, or the bucket holds f32 meshes too. */
  move: 'exact' | 'shared' | null;
  members: MeshData[];
  /** LOD1 indices the clustering kept over every part, or -1 when it refused one. */
  kept: number;
}

/** Each Scene's bucket key of each paged mesh (the key depends on its chunking). Cached: a mesh whose colour, id or model changes leaves its page first. */
const bucketKeys = new WeakMap<SceneCompactHost, WeakMap<MeshData, string>>();

export function bucketKeyOf(host: SceneCompactHost, mesh: MeshData, cachedOnly = false): string | undefined {
  let keys = bucketKeys.get(host);
  if (!keys) bucketKeys.set(host, (keys = new WeakMap()));
  let key = keys.get(mesh);
  if (key === undefined && !cachedOnly) {
    // The chunk cell is taken at the first source vertex, which the encoder writes first (welding keeps first occurrences).
    key = host.compactBucketKey(mesh, { origin: firstVertex(mesh.compact!), positions: ZERO_POSITION });
    keys.set(mesh, key);
  }
  return key;
}

/** Every page's meshes, grouped by the bucket the bucket path would file them in, in page order. */
export function collectGroups(store: CompactGeometryStore, host: SceneCompactHost, deps: CompactPageDeps, judge = true): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const page of store.pageList()) {
    for (const mesh of page.meshes) {
      if (!mesh.compact) continue; // written since it was paged: `buildPageLods` leaves its page as it is
      const key = bucketKeyOf(host, mesh)!;
      let group = groups.get(key);
      if (!group) {
        group = { bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, triangles: 0, fine: false, move: null, members: [], kept: 0 };
        groups.set(key, group);
      }
      const ref = mesh.compact!, row = compactRow(ref), b = ref.payload.bounds, o = ref.row * 6;
      for (let axis = 0; axis < 3; axis++) {
        group.bounds.min[axis] = Math.min(group.bounds.min[axis], b[o + axis]);
        group.bounds.max[axis] = Math.max(group.bounds.max[axis], b[o + 3 + axis]);
      }
      group.triangles += row.indexCount / 3;
      // A lattice finer than the bucket batch's: the bucket's collapsed it (one coarser only outgrew its window).
      if (compactStep(row.level) < deps.bucket.quantStep) group.fine = true;
      group.members.push(mesh);
    }
  }
  if (!judge) return groups; // an edit-time build: no group moves to its bucket, so none is judged
  const { quantStep, maxQuantExtent, maxCollapsedFraction } = deps.bucket;
  // Buckets that hold meshes of their own (f32 meshes no page draws), or will once the queue is flushed: their batch is
  // the union, so the group joins it. (A queued f32 mesh is keyed as the bucket path keys it: at its own first vertex.)
  const shared = new Set<string>();
  for (const [key, bucket] of host.buckets) if (bucket.meshData.length > 0) shared.add(key.replace(/#\d+$/, ''));
  for (const mesh of host.meshQueue) if (!mesh.compact) shared.add(host.compactBucketKey(mesh, mesh));
  for (const [key, group] of groups) {
    if (shared.has(key)) { group.move = 'shared'; continue; }
    // quantize.ts: the batch's lower corner floors to the lattice; past `maxQuantExtent` above it the batch stays f32.
    const { min, max } = group.bounds;
    for (let axis = 0; axis < 3; axis++) if (max[axis] - Math.floor(min[axis] / quantStep) * quantStep > maxQuantExtent) group.move = 'exact';
    if (!group.move && group.fine && entityCollapses(group.members, quantStep, maxCollapsedFraction)) group.move = 'exact';
  }
  return groups;
}

/** World position of a row's first record. */
function firstVertex(ref: CompactRef): [number, number, number] {
  const { vertexStart, level } = compactRow(ref);
  const step = compactStep(level), w = ref.payload.windows, r = ref.row * 3, records = ref.payload.records;
  const view = new DataView(records.buffer, records.byteOffset + vertexStart * COMPACT_RECORD_BYTES, 6);
  return [(w[r] + view.getUint16(0, true)) * step, (w[r + 1] + view.getUint16(2, true)) * step, (w[r + 2] + view.getUint16(4, true)) * step];
}
