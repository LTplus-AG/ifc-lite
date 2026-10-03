/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { RoomLayoutCache } from './room-layout-cache.js';
import { applyLayoutOp, readFaces, filterRoomFaces, type RoomPlateFactory } from './room-layout-core.js';
import { roomCandidatesFromFaces, occupancyTest } from './room-candidates.js';

const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url), available = existsSync(wasm);
let factory: RoomPlateFactory;
beforeAll(async () => {
  if (!available) { console.warn('Native Room reader tests require pnpm build:wasm'); return; }
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
  factory = runtime.SpacePlateHandle;
});
// #6232 area-partition invariant: four 0.2m walls enclose a 4×3m
// centreline rectangle. The native DCEL, never a JS detector, owns faces.
const walls: [number, number][][] = [
  [[20,19.9],[24,19.9],[24,20.1],[20,20.1]], [[23.9,20],[24.1,20],[24.1,23],[23.9,23]],
  [[20,22.9],[24,22.9],[24,23.1],[20,23.1]], [[19.9,20],[20.1,20],[20.1,23],[19.9,23]],
];
it.skipIf(!available)('shared native Room cache preserves edits across non-wall history and restores the exact earlier plate on Undo (#6232)', () => {
  const cache = new RoomLayoutCache();
  try {
    const original = cache.read('m', 42, .05, 'source', walls, factory);
    expect(original.faces).toHaveLength(1);
    const edited = original.plate.duplicate();
    try {
      expect(applyLayoutOp(edited, { kind: 'split', a: [21,20], b: [21,23] }, .1)).toBe(true);
      cache.file('m', 42, .05, 'cut', original.walls, edited, readFaces(edited));
    } catch (error) { edited.free(); throw error; }
    const cut = cache.read('m', 42, .05, 'cut', walls, factory);
    const carried = cache.read('m', 42, .05, 'property-edit', walls, factory);
    expect(cut.faces).toHaveLength(2);
    expect(carried.faces).toEqual(cut.faces);
    expect(carried.plate).not.toBe(cut.plate);
    expect(cache.read('m', 42, .05, 'source', walls, factory).faces).toEqual(original.faces);
    expect(cache.read('peer', 42, .05, 'cut', walls, factory).faces).toHaveLength(1);
  } finally { cache.clear(); }
});
it.skipIf(!available)('native candidate area and existing-space occupancy remain coherent after Room cutoff rereads (#6232)', () => {
  const cache = new RoomLayoutCache();
  try {
    const held = cache.read('m', 42, .05, 'source', walls, factory);
    const candidates = roomCandidatesFromFaces(held.faces, () => false, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].grossArea).toBeCloseTo(12);
    const occupied = occupancyTest([[[20,20],[24,20],[24,23],[20,23]]], []);
    expect(roomCandidatesFromFaces(held.faces, occupied, [])[0].taken).toBe(true);
    expect(filterRoomFaces(held.faces, 20)).toEqual([]);
    expect(filterRoomFaces(cache.read('m', 42, .05, 'source', walls, factory).faces, .3)).toHaveLength(1);
  } finally { cache.clear(); }
});


it.skipIf(!available)('filing an edited native plate reuses pre-commit faces without another WASM read (#6754)', () => {
  const cache = new RoomLayoutCache(), original = cache.read('m', 42, .05, 'source', walls, factory);
  const edited = original.plate.duplicate();
  let transferred = false, freed = 0;
  const free = edited.free.bind(edited);
  edited.free = () => { freed++; free(); };
  try {
    expect(applyLayoutOp(edited, { kind: 'split', a: [21,20], b: [21,23] }, .1)).toBe(true);
    const faces = readFaces(edited);
    expect(faces).toHaveLength(2);
    // A native reread here would happen after the model commit. The cache
    // must accept the already-validated faces while retaining handle ownership.
    edited.snapshot = () => { throw new Error('Unexpected native reread after commit'); };
    cache.file('m', 42, .05, 'cut', original.walls, edited, faces);
    transferred = true;
    expect(cache.read('m', 42, .05, 'cut', walls, factory).faces).toBe(faces);
  } finally { if (!transferred) edited.free(); cache.clear(); }
  expect(freed).toBe(1);
});
