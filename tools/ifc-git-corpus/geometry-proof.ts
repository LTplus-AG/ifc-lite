/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { indexLines, globalIdOf } from './step-text.js';

interface GeometryRow { hash: string; aabb: number[]; volume: number | null }
let initialized = false;

/** Real producer hashes and world-space bounds; every WASM handle is freed. */
function geometry(text: string): Map<string, GeometryRow> {
  if (!initialized) {
    initSync({ module: readFileSync(new URL('../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) });
    initialized = true;
  }
  const roots = new Map([...indexLines(text.split('\n')).values()].flatMap(row => {
    const id = globalIdOf(row);
    return id === null ? [] : [[row.id, id] as const];
  }));
  const api = new IfcAPI();
  try {
    api.setComputeGeometryHashes(1e-3);
    const bytes = new TextEncoder().encode(text), pre = api.buildPrePassOnce(bytes);
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const meshes = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      if (meshes.length === 0 || meshes.totalTriangles === 0) throw new Error('Corpus geometry oracle produced no meshes');
      const ids = meshes.geometryHashIds, hashes = meshes.geometryHashValues;
      const boxes = meshes.geometryAabbValues, volumes = meshes.geometryVolumeValues;
      const rows = new Map<string, GeometryRow>();
      for (let i = 0; i < ids.length; i++) {
        const key = roots.get(ids[i]);
        if (key) rows.set(key, { hash: String(hashes[i]), aabb: Array.from(boxes.slice(i * 6, i * 6 + 6)),
          volume: Number.isFinite(volumes[i]) ? volumes[i] : null });
      }
      if (rows.size === 0) throw new Error('Corpus meshes have no rooted geometry fingerprints');
      return rows;
    } finally { meshes.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
}

function requireRow(rows: Map<string, GeometryRow>, key: string): GeometryRow {
  const row = rows.get(key);
  if (!row || row.aabb.length !== 6 || !row.aabb.every(Number.isFinite)) throw new Error(`No world geometry for ${key}`);
  return row;
}

function unchangedOthers(before: Map<string, GeometryRow>, after: Map<string, GeometryRow>, excluded: ReadonlySet<string>): number {
  const keys = new Set([...before.keys(), ...after.keys()]);
  let count = 0;
  for (const key of keys) {
    if (excluded.has(key)) continue;
    const a = before.get(key), b = after.get(key);
    if (!a || !b || a.hash !== b.hash || JSON.stringify(a.aabb) !== JSON.stringify(b.aabb)) {
      throw new Error(`Unrelated product geometry changed: ${key}`);
    }
    count++;
  }
  return count;
}

/** #8197: a move is demonstrated by actual world geometry, never a skip flag. */
export function proveMove(beforeText: string, afterText: string, key: string) {
  const before = geometry(beforeText), after = geometry(afterText);
  const a = requireRow(before, key), b = requireRow(after, key);
  if (a.hash === b.hash) throw new Error('Moved wall retained its world geometry hash');
  const displacement = b.aabb.map((value, i) => value - a.aabb[i]);
  const expected = [0.25, 0, 0, 0.25, 0, 0];
  if (displacement.some((value, i) => Math.abs(value - expected[i]) > 1e-6)) {
    throw new Error(`Move oracle expected 250 mm along X: ${JSON.stringify(displacement)}`);
  }
  return { engine: 'source-built IfcAPI.processGeometryBatch', scope: 'geometry', target: key,
    before: a, after: b, unchangedProducts: unchangedOthers(before, after, new Set([key])) };
}

/** Two actual half-solids partition the original box and preserve its volume. */
export function proveSplit(beforeText: string, afterText: string, keys: readonly string[]) {
  const before = geometry(beforeText), after = geometry(afterText);
  const source = requireRow(before, keys[0]), left = requireRow(after, keys[1]), right = requireRow(after, keys[2]);
  if (after.has(keys[0]) || before.has(keys[1]) || before.has(keys[2])) throw new Error('Split did not replace product identities');
  if (source.volume === null || left.volume === null || right.volume === null
    || source.volume <= 0 || left.volume <= 0 || right.volume <= 0
    || Math.abs(source.volume - left.volume - right.volume) > 1e-6) throw new Error('Split lacks conserved closed-solid volume');
  const union = source.aabb.map((_, i) => i < 3 ? Math.min(left.aabb[i], right.aabb[i]) : Math.max(left.aabb[i], right.aabb[i]));
  if (union.some((value, i) => Math.abs(value - source.aabb[i]) > 1e-6)
    || Math.abs(left.aabb[3] - right.aabb[0]) > 1e-6) throw new Error('Split halves do not partition the original bounds');
  return { engine: 'source-built IfcAPI.processGeometryBatch', scope: 'geometry', source, halves: [left, right],
    unchangedProducts: unchangedOthers(before, after, new Set(keys)) };
}
