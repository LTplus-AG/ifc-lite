/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two independent 32-bit hashes of a template's geometry (positions, normals
 * and indices bit patterns: the vertex buffer draws all of them). The first
 * buckets; both together stand in for the full compare once a group's CPU
 * arrays were released.
 */
export function hashGeometry(positions: Float32Array, normals: Float32Array, indices: Uint32Array): [number, number] {
  let h = 0x811c9dc5, k = 0x9747b28c;
  const mix = (v: number): void => { h = Math.imul(h ^ v, 0x01000193); k = Math.imul(k ^ v, 0x5bd1e995); k ^= k >>> 13; };
  for (const f of [positions, normals]) {
    const p = new Uint32Array(f.buffer, f.byteOffset, f.length);
    for (let i = 0; i < p.length; i++) mix(p[i]!);
  }
  for (let i = 0; i < indices.length; i++) mix(indices[i]!);
  return [(h ^ (positions.length * 31 + indices.length)) >>> 0, k >>> 0];
}
