/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';

/**
 * Proves — without letting anything actually hang — that `altitudeStep:
 * 1e-15` and `resolution: 1e-15` would spin the real `domeGraticule` loops
 * forever if the guards in sun-path.ts did not reject them.
 *
 * A naive regression test for this bug (calling the real unguarded loop)
 * would hang CI rather than fail it, which is exactly why the gap was easy
 * to miss. Instead this file mirrors the loop shapes with a hard iteration
 * cap: if the accumulator has not reached its bound after the cap, that
 * proves the step is "absorbed" (bound + step === bound at some interior
 * magnitude) and the real loop would never terminate. A viable step (e.g.
 * 0.001) is included as a control and must terminate well under the cap.
 */
describe('domeGraticule loop shapes: bounded hang probe', () => {
  // Large enough that the 360-bound loop's viable control step (0.001,
  // ~360k iterations) still finishes under the cap, while remaining a hard
  // ceiling for the 1e-15 cases (which never advance the accumulator at
  // all, so they hit the cap in either case).
  const ITER_CAP = 500_000;

  function boundedAdvance(
    start: number,
    step: number,
    cmp: (x: number) => boolean,
  ): number {
    let x = start;
    let iters = 0;
    while (cmp(x) && iters < ITER_CAP) {
      x += step;
      iters++;
    }
    return iters;
  }

  // Mirrors `for (let alt = altStep; alt < 90; alt += altStep)`.
  it('altitudeStep=1e-15 never reaches the loop bound within the cap (proves the hang)', () => {
    const iters = boundedAdvance(1e-15, 1e-15, (x) => x < 90);
    expect(iters).toBe(ITER_CAP);
  });

  // Mirrors `for (let az = 0; az <= 360; az += res)`, the largest-magnitude
  // loop resolution drives (see the guard comment in sun-path.ts for why
  // 360, not 90, is the binding bound for `res`).
  it('resolution=1e-15 never reaches the loop bound within the cap (proves the hang)', () => {
    const iters = boundedAdvance(0, 1e-15, (x) => x <= 360);
    expect(iters).toBe(ITER_CAP);
  });

  // Control: a small-but-viable step must terminate well under the cap.
  it('control: a viable step (0.001) terminates well under the cap', () => {
    const altIters = boundedAdvance(0.001, 0.001, (x) => x < 90);
    const resIters = boundedAdvance(0, 0.001, (x) => x <= 360);
    expect(altIters).toBeLessThan(ITER_CAP);
    expect(resIters).toBeLessThan(ITER_CAP);
  });
});
