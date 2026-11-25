/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextAlignStep, recordAlignPick, roleForAlignStep, solveAlignPoints, ALIGN_STEPS, type AlignPoints } from './two-point-align-session.js';
import { alignTwoPoints } from './two-point-align.js';
import { buildAlignReadout, formatCheckDistance, type ReadoutTranslate } from './two-point-align-readout.js';

/** Echoes key and values so the test sees the numbers, not an English phrasing. */
const echo: ReadoutTranslate = (key, values) => `${key.split('.').pop()}:${Object.values(values).join('|')}`;
const solved = (a: [number, number, number], b: [number, number, number], aPrime: [number, number, number], bPrime: [number, number, number]) => {
  const result = alignTwoPoints({ a, b, aPrime, bPrime });
  assert.ok(result.ok);
  return result.alignment;
};

describe('two-point align pick sequence (#11505)', () => {
  it('asks for A, A\', B, B\' in that order, alternating moving and reference roles', () => {
    let points: AlignPoints = {};
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const step = nextAlignStep(points);
      assert.ok(step);
      seen.push(`${step}:${roleForAlignStep(step)}`);
      const role = roleForAlignStep(step)!;
      const next = recordAlignPick(points, role, [i, i, i]);
      assert.ok(next);
      points = next;
    }
    assert.deepEqual(seen, ['a:source', 'aPrime:target', 'b:source', 'bPrime:target']);
    assert.equal(nextAlignStep(points), null);
    assert.equal(roleForAlignStep(null), null);
    assert.deepEqual(ALIGN_STEPS, ['a', 'aPrime', 'b', 'bPrime']);
  });

  it('refuses a pick whose role does not belong to the current step, and a fifth pick', () => {
    assert.equal(recordAlignPick({}, 'target', [0, 0, 0]), null);
    const full = { a: [0, 0, 0], aPrime: [1, 0, 0], b: [2, 0, 0], bPrime: [3, 0, 0] } as const;
    assert.equal(recordAlignPick(full, 'source', [9, 9, 9]), null);
  });

  it('is not solvable until all four points exist, and does not alias the caller\'s point', () => {
    const point: [number, number, number] = [1, 2, 3];
    const one = recordAlignPick({}, 'source', point)!;
    point[0] = 99;
    assert.deepEqual(one.a, [1, 2, 3]);
    assert.equal(solveAlignPoints(one), null);
    assert.deepEqual(solveAlignPoints({ a: [0, 0, 0], aPrime: [0, 0, 0], b: [0, 0, 0], bPrime: [1, 0, 0] }), { ok: false, reason: 'moving-pair-degenerate' });
  });
});

describe('two-point align readout (#11505)', () => {
  it('shows a signed heading, the move, and a passing check without extra lines', () => {
    const readout = buildAlignReadout(solved([0, 0, 0], [10, 0, 0], [5, 6, 7], [5 + 10 * Math.cos(0.2164208), 6 + 10 * Math.sin(0.2164208), 7]), echo);
    assert.equal(readout.lines.length, 3);
    assert.equal(readout.lines[0], 'readoutRotation:+12.40');
    assert.equal(readout.lines[1], 'readoutMove:5.000|6.000|7.000');
    assert.match(readout.lines[2], /^readoutCheckOk:/);
    assert.equal(readout.warn, false);
  });

  it('warns on a miss over 10 mm, adds the ratio line past 0.1% and the elevation line past 10 mm', () => {
    const miss = buildAlignReadout(solved([0, 0, 0], [10, 0, 0], [0, 0, 0], [10.05, 0, 0]), echo);
    assert.match(miss.lines[2], /^readoutCheckWarn:/);
    assert.equal(miss.warn, true);
    const scaled = buildAlignReadout(solved([0, 0, 0], [10, 0, 0], [0, 0, 0], [10.2, 0, 0]), echo);
    assert.ok(scaled.lines.some((line) => line.startsWith('readoutRatio:0.9804')), scaled.lines.join('\n'));
    const rising = buildAlignReadout(solved([0, 0, 0], [10, 0, 0], [0, 0, 0], [10, 0, 0.5]), echo);
    assert.ok(rising.lines.some((line) => line === 'readoutDeltaZ:+0.500'));
    // A 5 mm elevation difference is inside the noise and gets no line of its own.
    assert.ok(!buildAlignReadout(solved([0, 0, 0], [10, 0, 0], [0, 0, 0], [10, 0, 0.005]), echo).lines.some((line) => line.startsWith('readoutDeltaZ')));
  });

  it('writes a negative heading with a minus and a zero heading without a sign', () => {
    assert.match(buildAlignReadout(solved([0, 0, 0], [1, 0, 0], [0, 0, 0], [Math.cos(-0.5), Math.sin(-0.5), 0]), echo).lines[0], /^readoutRotation:-28\.65$/);
    assert.equal(buildAlignReadout(solved([0, 0, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0]), echo).lines[0], 'readoutRotation:0.00');
    // A heading that rounds to zero is not "-0.00".
    assert.equal(buildAlignReadout(solved([0, 0, 0], [1000, 0, 0], [0, 0, 0], [1000, -1e-6, 0]), echo).lines[0], 'readoutRotation:0.00');
  });

  it('formats the check distance in millimetres below a metre', () => {
    assert.equal(formatCheckDistance(0.002), '2 mm');
    assert.equal(formatCheckDistance(0.0004), '0.4 mm');
    assert.equal(formatCheckDistance(0.0123), '12 mm');
    assert.equal(formatCheckDistance(0), '0 mm');
    assert.equal(formatCheckDistance(1.25), '1.250 m');
  });
});
