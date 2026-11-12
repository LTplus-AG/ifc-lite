/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Path-independent identity of what the scene holds, for the scoreboard's
 * untimed identity pass (loaded only under `?perf.sceneIdentity=1`, see
 * sceneIdentityTap.ts). Two layers:
 *
 * - pieces: every CPU geometry piece the scene keeps (`forEachMeshData`: flat
 *   pieces and materialized instanced occurrences), hashed over exact bytes
 *   (positions, normals, indices, colour, origin, localToWorld, uvs, shading,
 *   material) and summed per contributing entity id, so piece order never matters. Equal for a cold open and a faithful cache hit.
 * - snapshots: the batches a load wrote to the cache (after the writer moved
 *   their ordinals to the entry's mesh order) or a reopen adopted (sorted by
 *   key; vertex, index, id and ordinal bytes plus the table fields). An adopted
 *   snapshot must equal one an earlier open of the same file wrote.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { SceneContents, SceneSnapshot } from '@ifc-lite/renderer';

const PRIME = 0x01000193;

function mixBytes(h: number, view: ArrayBufferView | undefined | null): number {
  if (!view) return Math.imul(h ^ 0xfeedface, PRIME) >>> 0;
  const { buffer, byteOffset, byteLength } = view;
  const words = byteOffset % 4 === 0 ? new Uint32Array(buffer, byteOffset, byteLength >>> 2) : null;
  let i = 0;
  if (words) for (; i < words.length; i++) h = Math.imul(h ^ words[i], PRIME);
  const bytes = new Uint8Array(buffer, byteOffset, byteLength);
  for (let b = words ? words.length * 4 : 0; b < byteLength; b++) h = Math.imul(h ^ bytes[b], PRIME);
  return Math.imul(h ^ byteLength, PRIME) >>> 0;
}

function mixText(h: number, text: string): number {
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), PRIME);
  return h >>> 0;
}

const hex = (a: number, b: number) => `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;

/** One piece over its exact bytes, two seeds (64-bit signature). */
export function pieceSignature(md: MeshData): [number, number] {
  const one = (seed: number) => {
    let h = Math.imul(seed ^ (md.expressId >>> 0), PRIME);
    h = mixBytes(h, md.positions);
    h = mixBytes(h, md.normals);
    h = mixBytes(h, md.indices);
    h = mixBytes(h, Float32Array.from(md.color ?? []));
    // Everything else the renderer applies to this piece: placement, texture coordinates, shading (review #9863).
    h = mixBytes(h, md.origin ? Float64Array.from(md.origin) : null);
    h = mixBytes(h, md.localToWorld ? Float64Array.from(md.localToWorld) : null);
    h = mixBytes(h, md.uvs);
    h = mixBytes(h, md.shadingColor ? Float32Array.from(md.shadingColor) : null);
    h = mixText(h, JSON.stringify([md.material ?? null, md.entityIds ? Array.from(md.entityIds) : null]));
    return h >>> 0;
  };
  return [one(0x811c9dc5), one(0x9e3779b9)];
}

/** Batches sorted by key; any change to their bytes or table fields changes the signature. */
export function snapshotSignature(snapshot: SceneSnapshot): string {
  const one = (seed: number) => {
    let h = mixText(seed, JSON.stringify([snapshot.policy ?? '', snapshot.sharedFrameOrigins ?? null, snapshot.activeBuckets ?? null, snapshot.pieceCount, snapshot.nextSplitId]));
    const batches = [...snapshot.batches].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const b of batches) {
      h = mixText(h, JSON.stringify([b.key, b.color, b.finish ?? null, b.origin ?? null, b.bounds ?? null, b.quantized ?? null, b.modelIndex ?? null, b.vertexBytes]));
      h = mixBytes(h, b.vertexData);
      h = mixBytes(h, b.indices);
      h = mixBytes(h, b.expressIds);
      h = mixBytes(h, b.ordinals);
      h = mixBytes(h, b.lod1Indices);
    }
    return h >>> 0;
  };
  return `batches=${snapshot.batches.length} sig=${hex(one(0x811c9dc5), one(0x9e3779b9))}`;
}

export interface ScenePieceIdentity {
  pieces: number;
  elements: number;
  sig: string;
  /** expressId -> per-element signature, for a per-element diff. */
  perElement: Record<string, string>;
}

export function scenePieceIdentity(scene: Pick<SceneContents, 'forEachMeshData'>): ScenePieceIdentity {
  const a = new Map<number, number>(), b = new Map<number, number>();
  let pieces = 0;
  scene.forEachMeshData((md) => {
    const [x, y] = pieceSignature(md);
    // A colour-merged piece carries several entities: each contributor gets the piece (review #9863).
    const ids = md.entityIds && md.entityIds.length > 0 ? new Set([md.expressId, ...md.entityIds]) : [md.expressId];
    for (const id of ids) {
      a.set(id, ((a.get(id) ?? 0) + x) >>> 0);
      b.set(id, ((b.get(id) ?? 0) + y) >>> 0);
    }
    pieces++;
  });
  const perElement: Record<string, string> = {};
  let sumA = 0, sumB = 0;
  for (const [id, x] of a) {
    const y = b.get(id) ?? 0;
    perElement[id] = hex(x, y);
    sumA = (sumA + Math.imul(x ^ id, PRIME)) >>> 0;
    sumB = (sumB + Math.imul(y ^ id, 0x5bd1e995)) >>> 0;
  }
  return { pieces, elements: a.size, sig: hex(sumA, sumB), perElement };
}
