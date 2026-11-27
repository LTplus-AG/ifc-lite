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
/** The stream end's verdicts per Scene: bucket keys whose groups move to their buckets. */
const streamVerdicts = new WeakMap<SceneCompactHost, Map<string, 'exact' | 'shared'>>();

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

/** Forget a Scene's cached bucket keys and stream verdicts (it cleared: its chunking may change, the same meshes may come back). */
export function forgetGroups(host: SceneCompactHost): void {
  bucketKeys.delete(host);
  streamVerdicts.delete(host);
}

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

/**
 * Every page's meshes, grouped by the bucket the bucket path would file them in, in page order. `judge`: true at a stream end that grew pages (every group judged afresh); 'streamed' at one that grew none (only groups whose
 * bucket this stream wrote f32 meshes into move, as 'shared': earlier verdicts stand, and a bucket an edit wrote decodes nothing);
 * false for an edit-time build (the stream's verdicts).
 */
export function collectGroups(store: CompactGeometryStore, host: SceneCompactHost, deps: CompactPageDeps, judge: boolean | 'streamed' = true): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const page of store.pageList()) {
    for (const mesh of page.meshes) {
      const key = bucketKeyOf(host, mesh, !mesh.compact);
      if (key === undefined) continue; // written before any build keyed it: `buildPageLods` leaves its page as it is
      let group = groups.get(key);
      if (!group) {
        group = { bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, triangles: 0, fine: false, move: null, members: [], kept: 0 };
        groups.set(key, group);
      }
      if (!mesh.compact) { addWritten(group, mesh); continue; }
      const ref = mesh.compact, row = compactRow(ref), b = ref.payload.bounds, o = ref.row * 6;
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
  // An edit-time build judges no group again (none moves to its bucket); a group judged at the stream end keeps that verdict
  // for the meshes the bucket path refused, so they get no LOD1 either.
  if (!judge) {
    const verdicts = streamVerdicts.get(host);
    for (const [key, group] of groups) group.move = verdicts?.get(key) ?? null;
    return groups;
  }
  const verdicts = new Map<string, 'exact' | 'shared'>();
  if (judge === true) streamVerdicts.set(host, verdicts); // 'streamed' leaves the stream's verdicts as they are
  const { quantStep, maxQuantExtent, maxCollapsedFraction } = deps.bucket;
  // Buckets that hold meshes of their own (f32 meshes no page draws), or will once the queue is flushed: their batch is
  // the union, so the group joins it. (A queued f32 mesh is keyed as the bucket path keys it: at its own first vertex.)
  const shared = new Set<string>();
  for (const [key, bucket] of host.buckets) if (bucket.meshData.length > 0 && (judge === true || host.streamedBucketKeys.has(key))) shared.add(key.replace(/#\d+$/, ''));
  for (const mesh of host.meshQueue) if (!mesh.compact) shared.add(host.compactBucketKey(mesh, mesh));
  for (const [key, group] of groups) {
    if (shared.has(key)) { group.move = 'shared'; continue; }
    if (judge === 'streamed') continue;
    // quantize.ts: the batch's lower corner floors to the lattice; past `maxQuantExtent` above it the batch stays f32.
    const { min, max } = group.bounds;
    for (let axis = 0; axis < 3; axis++) if (max[axis] - Math.floor(min[axis] / quantStep) * quantStep > maxQuantExtent) group.move = 'exact';
    if (!group.move && group.fine && entityCollapses(group.members, quantStep, maxCollapsedFraction)) group.move = 'exact';
    if (group.move) verdicts.set(key, group.move);
  }
  return groups;
}

/**
 * A paged mesh written since a build keyed it: its page still draws it, so it counts for its group's box and
 * triangles, but with no records to cluster the group gets no LOD1 (`kept` -1) and the mesh is no member
 * (members are judged and clustered from their records; its page keeps its own buffer, `buildPageLods`).
 */
function addWritten(group: Group, mesh: MeshData): void {
  const p = mesh.positions, o = mesh.origin ?? [0, 0, 0];
  for (let v = 0; v + 2 < p.length; v += 3) {
    for (let axis = 0; axis < 3; axis++) {
      group.bounds.min[axis] = Math.min(group.bounds.min[axis], o[axis] + p[v + axis]);
      group.bounds.max[axis] = Math.max(group.bounds.max[axis], o[axis] + p[v + axis]);
    }
  }
  group.triangles += mesh.indices.length / 3;
  group.kept = -1;
}

/** World position of a row's first record. */
function firstVertex(ref: CompactRef): [number, number, number] {
  const { vertexStart, level } = compactRow(ref);
  const step = compactStep(level), w = ref.payload.windows, r = ref.row * 3, records = ref.payload.records;
  const view = new DataView(records.buffer, records.byteOffset + vertexStart * COMPACT_RECORD_BYTES, 6);
  return [(w[r] + view.getUint16(0, true)) * step, (w[r + 1] + view.getUint16(2, true)) * step, (w[r + 2] + view.getUint16(4, true)) * step];
}
