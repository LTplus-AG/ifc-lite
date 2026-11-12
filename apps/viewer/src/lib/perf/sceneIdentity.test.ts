/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import type { SceneSnapshot } from '@ifc-lite/renderer';
import { pieceSignature, scenePieceIdentity, snapshotSignature } from './sceneIdentity.js';
import { sceneIdentityEnabled, tapSceneSnapshot, tappedSceneSnapshots } from './sceneIdentityTap.js';

const mesh = (expressId: number, shift = 0): MeshData => ({
  expressId,
  positions: new Float32Array([0, 0, 0, 1 + shift, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: [0.5, 0.5, 0.5, 1],
} as MeshData);

const batch = (key: string, byte: number) => ({
  key, color: [1, 1, 1, 1] as [number, number, number, number], vertexBytes: 16,
  expressIds: new Uint32Array([7]), ordinals: new Uint32Array([0]),
  vertexData: new Uint8Array([byte, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), indices: new Uint32Array([0, 1, 2]),
});
const snapshot = (batches: ReturnType<typeof batch>[]): SceneSnapshot => ({ policy: 'p', pieceCount: 1, nextSplitId: 0, sharedFrameOrigins: [], activeBuckets: [], batches });
const sceneOf = (pieces: MeshData[]) => ({ forEachMeshData: (visit: (md: MeshData) => void) => pieces.forEach(visit) });

describe('scene identity (scoreboard identity pass)', () => {
  it('a piece signature covers its exact bytes', () => {
    assert.deepEqual(pieceSignature(mesh(1)), pieceSignature(mesh(1)), 'same bytes, same signature');
    assert.notDeepEqual(pieceSignature(mesh(1)), pieceSignature(mesh(1, 1e-6)), 'one moved vertex changes it');
    assert.notDeepEqual(pieceSignature(mesh(1)), pieceSignature(mesh(2)), 'the expressId is part of it');
  });

  it('the piece layer ignores piece order and sees any changed element', () => {
    const a = scenePieceIdentity(sceneOf([mesh(1), mesh(2), mesh(3)]));
    const b = scenePieceIdentity(sceneOf([mesh(3), mesh(1), mesh(2)]));
    assert.equal(a.sig, b.sig, 'order-independent');
    assert.equal(a.elements, 3);
    const c = scenePieceIdentity(sceneOf([mesh(3), mesh(1, 0.5), mesh(2)]));
    assert.notEqual(a.sig, c.sig, 'a changed element changes the layer');
    assert.notEqual(a.perElement['1'], c.perElement['1'], 'and its per-element entry');
    assert.equal(a.perElement['2'], c.perElement['2'], 'other elements keep theirs');
    assert.notEqual(a.sig, scenePieceIdentity(sceneOf([mesh(1), mesh(2)])).sig, 'a missing element changes the layer');
  });

  it('a snapshot signature ignores batch order and sees one flipped vertex byte (the altered-snapshot control)', () => {
    const s = snapshotSignature(snapshot([batch('a', 1), batch('b', 1)]));
    assert.equal(s, snapshotSignature(snapshot([batch('b', 1), batch('a', 1)])), 'batch order does not matter');
    assert.notEqual(s, snapshotSignature(snapshot([batch('a', 1), batch('b', 0x81)])), 'one flipped byte changes it');
    assert.ok(s.startsWith('batches=2 sig='), s);
  });

  it('with the flag off a tap records nothing', () => {
    assert.equal(sceneIdentityEnabled(), false, 'off by default');
    tapSceneSnapshot('captured', snapshot([batch('a', 1)]));
    assert.equal(tappedSceneSnapshots().snapshots.length, 0, 'nothing kept, nothing loaded');
  });

  describe('with ?perf.sceneIdentity=1', () => {
    const g = globalThis as Record<string, unknown>;
    const saved = g.location;
    afterEach(() => { g.location = saved; });
    it('a tap hashes off the load path and reports when done', async () => {
      g.location = { search: '?perf.sceneIdentity=1', href: 'http://x/?perf.sceneIdentity=1' };
      assert.equal(sceneIdentityEnabled(), true);
      tapSceneSnapshot('adopted', snapshot([batch('a', 1)]));
      for (let i = 0; i < 50 && tappedSceneSnapshots().pending > 0; i++) await new Promise((r) => setTimeout(r, 10));
      const { snapshots, pending } = tappedSceneSnapshots();
      assert.equal(pending, 0);
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0].kind, 'adopted');
      assert.equal(snapshots[0].sig, snapshotSignature(snapshot([batch('a', 1)])));
    });
  });
});
