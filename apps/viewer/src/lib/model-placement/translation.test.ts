/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addTranslation, subtractTranslation, constrainTranslation, orthogonalAxis,
  parseMoveLength, translationAtDistance, fromRenderTranslation, toRenderTranslation } from './translation.js';
import { beginPlacement, cancelPlacement, commitPlacement, displayedTranslation, emptyPlacementState,
  previewPlacement, replayPlacement, resetPlacements, retainLoadedPlacements } from './state.js';

describe('workspace placement invariants (#4226)', () => {
  it('retains a millimetre correction after a ten-million-metre source offset', () => {
    const source = [10_000_000, -2_600_000, 450] as const;
    const target = [0.001, 5, 0] as const;
    const result = addTranslation(source, subtractTranslation(target, source));
    assert.ok(Math.abs(result[0] - target[0]) < 0.0001);
    assert.equal(result[1], target[1]);
    assert.equal(result[2], target[2]);
  });

  it('converts engineering axes to rendering axes without changing lengths', () => {
    const engineering = [12, -30, 4] as const;
    const [x, y, z] = toRenderTranslation(engineering);
    assert.deepEqual([x, y, z], [12, 4, 30]);
    assert.deepEqual(fromRenderTranslation({ x, y, z }), engineering);
  });

  it('never lets a snap change a constrained component and stabilizes Shift ortho', () => {
    assert.deepEqual(constrainTranslation([3, 5, 9], 'xy'), [3, 5, 0]);
    assert.deepEqual(constrainTranslation([3, 5, 9], 'z'), [0, 0, 9]);
    assert.equal(orthogonalAxis([10, 11, 100], 'xy', 'x'), 'x');
    assert.equal(orthogonalAxis([10, 13, 100], 'xy', 'x'), 'y');
    assert.deepEqual(translationAtDistance([0, 0, 1], -0.001), [0, 0, -0.001]);
    assert.throws(() => translationAtDistance([0, 0, 0], 2), /direction/);
  });

  it('accepts signed units while rejecting partial or non-finite numeric input', () => {
    assert.equal(parseMoveLength('125 mm'), 0.125);
    assert.equal(parseMoveLength('-0,25 m'), -0.25);
    assert.equal(parseMoveLength('1e3 mm'), 1);
    assert.equal(parseMoveLength('2 ft'), 0.6096);
    for (const input of ['', '10garbage', '1,000.25', 'Infinity', '1e999', '2+3', '0x10', '1 m m']) {
      assert.throws(() => parseMoveLength(input), Error, input);
    }
  });

  const ids = new Set(['ifc', 'scan']);
  const move = () => previewPlacement(beginPlacement(emptyPlacementState(), [...ids], ids), [1, 2, 3]);

  it('previews a mixed group without committing, and cancellation restores both', () => {
    const preview = move();
    assert.equal(preview.placements.size, 0);
    assert.deepEqual(displayedTranslation(preview, 'scan'), [1, 2, 3]);
    const cancelled = cancelPlacement(preview);
    for (const id of ids) assert.deepEqual(displayedTranslation(cancelled, id), [0, 0, 0]);
    assert.equal(cancelled.undo.length, 0);
  });

  it('commits one group operation and restores exact positions across repeated undo/redo', () => {
    let state = commitPlacement(move());
    assert.equal(state.undo.length, 1);
    for (let i = 0; i < 100; i++) {
      state = replayPlacement(state, 'undo');
      for (const id of ids) assert.deepEqual(displayedTranslation(state, id), [0, 0, 0]);
      state = replayPlacement(state, 'redo');
      for (const id of ids) assert.deepEqual(displayedTranslation(state, id), [1, 2, 3]);
    }
    const reset = resetPlacements(state, ['scan']);
    assert.deepEqual(displayedTranslation(reset, 'ifc'), [1, 2, 3]);
    assert.deepEqual(displayedTranslation(reset, 'scan'), [0, 0, 0]);
    assert.deepEqual(displayedTranslation(replayPlacement(reset, 'undo'), 'scan'), [1, 2, 3]);
  });

  it('no-op apply preserves redo and removing a member invalidates group history', () => {
    const undone = replayPlacement(commitPlacement(move()), 'undo');
    const noOp = commitPlacement(beginPlacement(undone, ['scan'], ids));
    assert.equal(noOp.redo.length, 1);
    const removed = retainLoadedPlacements(noOp, new Set(['ifc']));
    assert.equal(removed.redo.length, 0);
    assert.equal(removed.placements.has('scan'), false);
    assert.equal(retainLoadedPlacements(move(), new Set(['ifc'])).preview, null);
  });

  it('refuses locked or missing members atomically and rejects overflow before preview', () => {
    const state = emptyPlacementState();
    const locked = { ...state, placements: new Map([['scan', { translation: [0, 0, 0] as const, locked: true }]]) };
    assert.throws(() => beginPlacement(locked, ['ifc', 'scan'], ids), /Unlock/);
    assert.throws(() => beginPlacement(state, ['missing'], ids), /no longer loaded/);
    const far = { ...state, placements: new Map([['scan', { translation: [1e308, 0, 0] as const, locked: false }]]) };
    assert.throws(() => previewPlacement(beginPlacement(far, ['scan'], ids), [1e308, 0, 0]), /finite/);
    assert.equal(far.preview, null);
  });
});

import { dragTranslation } from './drag.js';
import { importPlacements } from './state.js';

describe('drag and atomic import invariants (#4226)', () => {
  it('solves oblique plane motion and refuses edge-on planes', () => {
    const basis = [{ axis: 0 as const, screen: { x: 4, y: 3 } }, { axis: 2 as const, screen: { x: -2, y: 5 } }];
    assert.deepEqual(dragTranslation(basis, { x: 14, y: 4 }), [3, 0, -1]);
    assert.deepEqual(dragTranslation([basis[0]], { x: 8, y: 6 }), [2, 0, 0]);
    assert.equal(dragTranslation([{ axis: 0, screen: { x: 1, y: 0 } }, { axis: 1, screen: { x: 2, y: 0 } }], { x: 3, y: 4 }), null);
    assert.equal(dragTranslation([{ axis: 0, screen: { x: 0, y: 0 } }], { x: 3, y: 4 }), null);
  });

  it('imports a group as one reversible move and refuses a partial locked import', () => {
    const base = emptyPlacementState();
    const incoming = new Map([['ifc', { translation: [1, 2, 3] as const, locked: true }], ['scan', { translation: [4, 5, 6] as const, locked: false }]]);
    const imported = importPlacements(base, incoming);
    assert.equal(imported.undo.length, 1);
    assert.deepEqual(displayedTranslation(replayPlacement(imported, 'undo'), 'ifc'), [0, 0, 0]);
    assert.deepEqual(displayedTranslation(replayPlacement(replayPlacement(imported, 'undo'), 'redo'), 'scan'), [4, 5, 6]);
    const locked = { ...base, placements: new Map([['scan', { translation: [0, 0, 0] as const, locked: true }]]) };
    assert.throws(() => importPlacements(locked, incoming), /Unlock/);
    assert.deepEqual(displayedTranslation(locked, 'ifc'), [0, 0, 0]);
  });
});

import { createModelIndexAllocator, geometryWithModelIndex } from './model-indices.js';

it('keeps retained instance ownership stable after removal, addition, and single-model fallback (#4226)', () => {
  const indices = createModelIndexAllocator();
  assert.deepEqual([...indices(new Map([['ifc', {}], ['scan', {}]]))], [['ifc', 0], ['scan', 1]]);
  const remaining = indices(new Map([['scan', {}]]));
  assert.equal(remaining.get('scan'), 1);
  const zero = { x: 0, y: 0, z: 0 };
  const geometry = geometryWithModelIndex({ meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: { originShift: zero, originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, hasLargeCoordinates: false },
    pointClouds: [{ expressId: 9, chunk: { positions: new Float32Array([1, 2, 3]), pointCount: 1, bbox: { min: [1, 2, 3], max: [1, 2, 3] } } }] }, remaining.get('scan')!);
  assert.equal(geometry?.pointClouds?.[0].modelIndex, 1);
  assert.deepEqual([...indices(new Map([['scan', {}], ['replacement', {}]]))], [['scan', 1], ['replacement', 2]]);
  indices(new Map());
  assert.equal(indices(new Map([['new-session', {}]])).get('new-session'), 0);
});

import { placedFlatGeometry } from './placed-geometry';
import { placedSymbols } from './placed-symbols';
import { createEmptyParseResult } from '../overlay-parse/symbolic-shapes';
import { placementSnapshot, placementSnapshotIsCurrent } from './placement-snapshot';
import type { GeometryResult } from '@ifc-lite/geometry';

it('places drawing/export triangles and local placement metadata without mutating sources (#4226)', () => {
  const zero = { x: 0, y: 0, z: 0 };
  const source: GeometryResult = { meshes: [{ expressId: 1, origin: [10, 20, 30], positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
    localToWorld: [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1] }], totalVertices: 3, totalTriangles: 1,
    coordinateInfo: { originShift: zero, originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, hasLargeCoordinates: false } };
  const placed = placedFlatGeometry(source, () => [2, 3, 4]);
  assert.deepEqual(placed.meshes[0].origin, [12, 24, 27]);
  assert.equal(placed.meshes[0].localToWorld![7], 24);
  assert.deepEqual(placed.coordinateInfo.shiftedBounds.max, { x: 13, y: 25, z: 27 });
  assert.deepEqual(source.meshes[0].origin, [10, 20, 30]);
  assert.equal(source.meshes[0].localToWorld![7], 20);
  assert.strictEqual(placed.meshes[0].positions, source.meshes[0].positions);
  source.meshes[0].positions[3] = 5; // A real authoring edit changes the source buffer in place.
  const edited = placedFlatGeometry(source, () => [2, 3, 4], 1);
  assert.equal(edited.coordinateInfo.shiftedBounds.max.x, 17, 'authoring invalidates cached local bounds');
  source.meshes[0].positions[3] = 8;
  source.coordinateInfo = { ...source.coordinateInfo }; // Source realignment replaces its frame.
  assert.equal(placedFlatGeometry(source, () => [2, 3, 4], 1).coordinateInfo.shiftedBounds.max.x, 20);
});

it('moves symbolic lines and their clipping elevation together, including loose annotations (#4226)', () => {
  const source = createEmptyParseResult();
  source.loose.push({ line: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }, category: 'annotation' });
  const moved = placedSymbols(source, [2, 3, 4], 10)!;
  const bucket = [...moved.byStorey.values()][0];
  assert.equal(bucket.storeyElevation, 14);
  assert.deepEqual(bucket.lines[0].line.start, { x: 2, y: -3 });
  assert.equal(moved.loose.length, 0);
  assert.equal(source.byStorey.size, 0);
  assert.deepEqual(source.loose[0].line.start, { x: 0, y: 0 });
});

it('refuses an asynchronous analysis result after a contributing model moves or disappears (#4226)', () => {
  const state = { models: new Map([['a', {}], ['b', {}]]), modelPlacement: emptyPlacementState(), pointCloudAlignmentEnabled: true };
  const snapshot = placementSnapshot(state, ['a']);
  const otherMoved = { ...state, modelPlacement: importPlacements(state.modelPlacement, new Map([['b', { translation: [1, 0, 0], locked: false }]])) };
  assert.equal(placementSnapshotIsCurrent(snapshot, otherMoved), true);
  const moved = { ...state, modelPlacement: importPlacements(state.modelPlacement, new Map([['a', { translation: [0.001, 0, 0], locked: false }]])) };
  assert.equal(placementSnapshotIsCurrent(snapshot, moved), false);
  assert.equal(placementSnapshotIsCurrent(snapshot, { ...state, models: new Map([['b', {}]]) }), false);
});
