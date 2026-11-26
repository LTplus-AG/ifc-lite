/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beginPlacement, emptyPlacementState, importPlacements, placementFor, previewPlacement,
  replayPlacement, type ModelPlacement, type PlacementState } from './state.js';
import { modelPointToWorkspacePoint, workspacePointToModelFrame } from './rotation.js';
import type { Translation } from './translation.js';
import { alignTwoPoints, type TwoPointAlignInput } from './two-point-align.js';
import { alignPlacements } from './two-point-align-apply.js';
import { testPlacement } from './test-fixtures.js';

const near = (actual: Translation, expected: Translation, label: string, tolerance = 1e-7) => {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${label}[${i}]: ${actual[i]} vs ${expected[i]}`);
};
const alignment = (input: TwoPointAlignInput) => {
  const result = alignTwoPoints(input);
  assert.ok(result.ok);
  return result.alignment;
};
function seed(placements: Record<string, ModelPlacement>): PlacementState {
  return importPlacements(emptyPlacementState(), new Map(Object.entries(placements)));
}
/** A point as it is drawn now: the model-frame point through the placement. */
const shown = (state: PlacementState, id: string, modelPoint: Translation) => modelPointToWorkspacePoint(modelPoint, placementFor(state, id));

describe('two-point align commit (#11505)', () => {
  const input: TwoPointAlignInput = { a: [100, 50, 2], b: [160, 90, 2], aPrime: [-30, 400, 5], bPrime: [-70, 460, 5] };

  it('lands the picked A on A\' and B on B\' for an unplaced model', () => {
    const state = alignPlacements(emptyPlacementState(), ['m'], alignment(input));
    near(shown(state, 'm', input.a), input.aPrime, 'A');
    near(shown(state, 'm', input.b), input.bPrime, 'B');
    assert.ok(Math.abs(placementFor(state, 'm').rotation.angle - Math.PI / 2) < 1e-12);
  });

  it('composes with a model that already has a heading and a move, per model', () => {
    const start = seed({
      p: testPlacement([12, -7, 0.5], { rotation: { angle: 0.6, pivot: [3, 4, 0] } }),
      q: testPlacement([-300, 80, 0]),
    });
    // Picks are taken on the DISPLAYED models: A, B on p; q rides the same transform.
    const modelA: Translation = [10, 20, 1], modelB: Translation = [70, 20, 1];
    const a = shown(start, 'p', modelA), b = shown(start, 'p', modelB);
    const qModelPoint: Translation = [5, 5, 0];
    const qBefore = shown(start, 'q', qModelPoint);
    const result = alignment({ a, b, aPrime: [1000, 2000, 10], bPrime: [1000, 2060, 10] });
    const state = alignPlacements(start, ['p', 'q'], result);
    near(shown(state, 'p', modelA), [1000, 2000, 10], 'A on A\'');
    near(shown(state, 'p', modelB), [1000, 2060, 10], 'B on B\'');
    // The transform is a workspace one, so q's point moves by exactly the same rotation + move.
    const rotated: Translation = [
      1000 + (qBefore[0] - a[0]) * Math.cos(result.heading) - (qBefore[1] - a[1]) * Math.sin(result.heading),
      2000 + (qBefore[0] - a[0]) * Math.sin(result.heading) + (qBefore[1] - a[1]) * Math.cos(result.heading),
      10 + (qBefore[2] - a[2])];
    near(shown(state, 'q', qModelPoint), rotated, 'q follows the same workspace transform');
  });

  it('is one undoable step that restores both translation and rotation', () => {
    const start = seed({ m: testPlacement([1, 2, 3], { rotation: { angle: 0.3, pivot: [9, 9, 0] } }) });
    const done = alignPlacements(start, ['m'], alignment(input));
    assert.equal(done.undo.length, start.undo.length + 1);
    const undone = replayPlacement(done, 'undo');
    assert.deepEqual(placementFor(undone, 'm'), placementFor(start, 'm'));
  });

  it('a pure move keeps the model unrotated; an existing heading is cancelled when the pairs undo it', () => {
    const pure = alignPlacements(emptyPlacementState(), ['m'], alignment({ a: [0, 0, 0], b: [10, 0, 0], aPrime: [5, 6, 7], bPrime: [15, 6, 7] }));
    assert.equal(placementFor(pure, 'm').rotation.angle, 0);
    assert.deepEqual(placementFor(pure, 'm').translation, [5, 6, 7]);
    const turned = seed({ m: testPlacement([0, 0, 0], { rotation: { angle: Math.PI / 2, pivot: [0, 0, 0] } }) });
    const a = shown(turned, 'm', [0, 0, 0]), b = shown(turned, 'm', [10, 0, 0]);
    const back = alignPlacements(turned, ['m'], alignment({ a, b, aPrime: a, bPrime: [a[0] + 10, a[1], a[2]] }));
    assert.equal(placementFor(back, 'm').rotation.angle, 0, 'net heading is exactly zero, not 1e-16');
  });

  it('treats a net heading that is only pick noise as no heading (viewer run, #11505)', () => {
    // Picks come off float32 mesh vertices, so a model turned back to the reference's
    // heading nets ~1e-8 rad, not 0. That must not be stored as a (barely visible) rotation.
    const turned = seed({ m: testPlacement([30, 8, 0], { rotation: { angle: 17.5 * Math.PI / 180, pivot: [6, -4, 0] } }) });
    const f = (p: Translation): Translation => [Math.fround(p[0]), Math.fround(p[1]), Math.fround(p[2])];
    const aPrime: Translation = [-0.5, 5, 6.3176915645599365];
    const bPrime: Translation = [12.5, 5, 6.3176915645599365];
    const a = f(shown(turned, 'm', aPrime));
    const b = f(shown(turned, 'm', bPrime));
    const result = alignment({ a, b, aPrime, bPrime });
    assert.ok(Math.abs(result.heading + 17.5 * Math.PI / 180) < 1e-6, 'the pairs undo the heading');
    const done = alignPlacements(turned, ['m'], result);
    assert.equal(placementFor(done, 'm').rotation.angle, 0);
    near(shown(done, 'm', aPrime), aPrime, 'A on A\'', 2e-6);
  });

  it('carries a pending move preview instead of dropping it, and keeps A on A\'', () => {
    const start = previewPlacement(beginPlacement(seed({ m: testPlacement([0, 0, 0]) }), ['m'], new Set(['m'])), [40, 0, 0]);
    // The model is DRAWN at +40 m; A and B were picked there.
    const a = shown({ ...start, placements: new Map([['m', testPlacement([40, 0, 0])]]) }, 'm', [0, 0, 0]);
    const b: Translation = [a[0], a[1] + 10, a[2]];
    const state = alignPlacements(start, ['m'], alignment({ a, b, aPrime: [0, 0, 0], bPrime: [-10, 0, 0] }));
    assert.equal(state.preview, null);
    near(shown(state, 'm', [0, 0, 0]), [0, 0, 0], 'A');
    near(shown(state, 'm', [0, 10, 0]), [-10, 0, 0], 'B');
  });

  it('refuses locked models and large-coordinate overflow before changing anything', () => {
    const locked: PlacementState = { ...emptyPlacementState(), placements: new Map([['m', testPlacement([0, 0, 0], { locked: true })]]) };
    assert.throws(() => alignPlacements(locked, ['m'], alignment(input)), /Unlock/);
    assert.throws(() => alignPlacements(emptyPlacementState(), ['m'],
      alignment({ a: [0, 0, 0], b: [1e30, 0, 0], aPrime: [1e39, 0, 0], bPrime: [1e39 + 1e30, 0, 0] })), /renderable/);
    assert.throws(() => alignPlacements(emptyPlacementState(), [], alignment(input)), /at least one/);
  });

  it('a placement and its inverse agree after the align (the pick round trip)', () => {
    const state = alignPlacements(emptyPlacementState(), ['m'], alignment(input));
    const placed = shown(state, 'm', input.b);
    near(workspacePointToModelFrame(placed, placementFor(state, 'm')), input.b, 'B round trip');
  });
});
