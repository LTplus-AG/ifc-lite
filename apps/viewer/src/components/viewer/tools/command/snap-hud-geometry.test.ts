/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SnapKind, SnapQuery, SnapResult } from '@/lib/snap/types';
import { solveSnap } from '@/lib/snap/solve';
import { MODELING_SNAP_PROFILE } from '@/lib/snap/rank';
import { glyphFor, guideStrokes } from './snap-hud-geometry.js';

const result = (patch: Partial<SnapResult>): SnapResult => ({ local: [5, 0], winner: null, guides: [], locked: false, ...patch });
const won = (kind: SnapKind): SnapResult => result({ winner: { kind, local: [5, 0], source: 'inference' } });

describe('glyphFor (#6232 WP3)', () => {
  it('gives every snap kind its glyph, and a bare workplane hit none', () => {
    const kinds: SnapKind[] = ['endpoint', 'vertex', 'midpoint', 'intersection', 'perpendicular', 'extension', 'parallel', 'edge', 'face', 'grid', 'workplane'];
    assert.deepEqual(kinds.map((k) => glyphFor(won(k))), [
      'endpoint', 'endpoint', 'midpoint', 'intersection', 'perpendicular', 'extension', 'parallel', 'edge', 'center', 'grid', null,
    ]);
    assert.equal(glyphFor(result({})), null);
    assert.equal(glyphFor(null), null);
  });
});

describe('guideStrokes', () => {
  it('runs an extension from the nearer end of its edge, and keeps the edge', () => {
    const edge = { kind: 'segment', a: [0, 0], b: [4, 0], role: 'edge' } as const;
    const strokes = guideStrokes(result({ guides: [{ kind: 'line', origin: [0, 0], dir: [4, 0], role: 'extension' }, edge] }));
    assert.deepEqual(strokes, [
      { kind: 'through', from: [4, 0], to: [5, 0], role: 'extension' },
      { kind: 'segment', a: [0, 0], b: [4, 0], role: 'edge' },
    ]);
  });

  it('draws a lock line from its anchor, a circle as a circle, and skips duplicates and zero-length guides', () => {
    const strokes = guideStrokes(result({
      guides: [
        { kind: 'line', origin: [1, 0], dir: [1, 0], role: 'lock' },
        { kind: 'circle', center: [1, 0], radius: 4, role: 'lock' },
        { kind: 'segment', a: [0, 1], b: [9, 1], role: 'edge' },
        { kind: 'segment', a: [0, 1], b: [9, 1], role: 'edge' },
        { kind: 'line', origin: [5, 0], dir: [0, 1], role: 'axis' },
      ],
    }));
    assert.deepEqual(strokes.map((s) => `${s.kind}:${s.role}`), ['through:lock', 'circle:lock', 'segment:edge']);
  });
});

describe('guideStrokes on real solver results (#6232 WP3)', () => {
  const q = (patch: Partial<SnapQuery>): SnapQuery => ({
    cursor: [3, 0.4], metresPerPixel: 0.01, anchor: [0, 0], chain: [[0, 0]],
    modifiers: { shift: false, alt: false }, locks: {}, ...patch,
  });
  const solve = (patch: Partial<SnapQuery>) => solveSnap(q(patch), [], { ...MODELING_SNAP_PROFILE, sources: [] });

  it('Shift (ortho / angle step) draws the lock line from the anchor through the solved point', () => {
    const snap = solve({ cursor: [3, 0.1], modifiers: { shift: true, alt: false } });
    assert.ok(snap.locked);
    assert.deepEqual(snap.local, [3, 0]);
    assert.deepEqual(guideStrokes(snap), [{ kind: 'through', from: [0, 0], to: [3, 0], role: 'lock' }]);
  });

  it('a typed angle draws its ray from the anchor', () => {
    const snap = solve({ cursor: [2, 2.2], locks: { angleDeg: 45 } });
    const [s] = guideStrokes(snap);
    assert.equal(s.kind, 'through');
    assert.equal(s.role, 'lock');
    assert.deepEqual(s.kind === 'through' && s.from, [0, 0]);
    const [x, y] = snap.local;
    assert.ok(Math.abs(x - y) < 1e-9, 'the solved point is on the 45 degree ray');
  });

  it('a typed length draws the circle around the anchor', () => {
    const snap = solve({ locks: { length: 2 } });
    assert.deepEqual(guideStrokes(snap), [{ kind: 'circle', center: [0, 0], radius: 2, role: 'lock' }]);
  });

  it('an intersection of two extension lines draws each from its own nearer wall end', () => {
    // Walls (0,0)->(4,0) and (6,-5)->(6,-1): their extensions cross at (6, 0).
    const strokes = guideStrokes(result({
      local: [6, 0],
      guides: [
        { kind: 'line', origin: [0, 0], dir: [4, 0], role: 'extension' },
        { kind: 'line', origin: [6, -5], dir: [0, 4], role: 'extension' },
      ],
    }));
    assert.deepEqual(strokes, [
      { kind: 'through', from: [4, 0], to: [6, 0], role: 'extension' },
      { kind: 'through', from: [6, -1], to: [6, 0], role: 'extension' },
    ]);
  });
});
