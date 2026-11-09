/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orthographic axis views are exact (#9501).
 *
 * The top and bottom presets stopped 0.01 rad off the pole, so an
 * orthographic plan drew 13 mm of a 1.3 m column's walls beside its section:
 * inside a hollow section, and as a dark band along one face. The scoreboard
 * in `test/ortho-fidelity.ts` drives every preset and rotation, orbit, pan,
 * zoom and `setRotation` through the real camera; this pins its score at zero.
 *
 * Hill-climbing: `ORTHO_FIDELITY_REPORT=1` prints the per-case table (or
 * `=json` the raw cases) before the assertions run:
 *
 *   ORTHO_FIDELITY_REPORT=1 pnpm --dir packages/renderer exec tsx --test src/camera-ortho-fidelity.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { type FidelityCase, isFailing, JOINT, orthoCamera, applyPreset, PRESET_AXIS, scoreOrthoFidelity, smearPx, summarize } from './test/ortho-fidelity.js';

function report(cases: readonly FidelityCase[]): string {
  const summary = summarize(cases);
  if (process.env.ORTHO_FIDELITY_REPORT === 'json') return JSON.stringify({ summary, cases }, null, 2);
  const f = (n: number) => (n === 0 ? '0' : n < 1e-3 ? n.toExponential(1) : n.toFixed(3));
  const rows = cases.map(c => [
    isFailing(c) ? 'FAIL' : 'ok', c.name, f(c.smearPx), f(c.upErrorDeg), f(c.angleErrorDeg),
    f(c.orbitJumpDeg), f(c.tiltErrorDeg), String(c.offscreen),
  ]);
  const head = ['', 'case', 'smear px', 'up deg', 'angle deg', 'jump deg', 'tilt deg', 'offscreen'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const table = [head, ...rows].map(r => r.map((x, i) => x.padEnd(widths[i]!)).join('  ')).join('\n');
  return `${table}\n\nscore ${f(summary.score)}  (${summary.failing}/${summary.cases} failing; max smear ${f(summary.maxSmearPx)} px)`;
}

describe('orthographic fidelity (#9501)', () => {
  const cases = scoreOrthoFidelity();
  if (process.env.ORTHO_FIDELITY_REPORT) process.stdout.write(`${report(cases)}\n`);

  it('covers every axis preset, rotation and navigation path', () => {
    // 2 x 4 plan/soffit presets + 4 elevations, 8 preset orbits, 4 pan/zoom,
    // 4 plan-viewpoint orbits, 6 setRotation.
    assert.equal(cases.length, 34);
    assert.ok(JOINT.some(b => b.name.startsWith('column')), 'scene has the hollow column');
  });

  for (const c of cases) {
    it(c.name, () => {
      assert.ok(!isFailing(c), JSON.stringify(c));
    });
  }

  it('scores zero overall', () => {
    assert.equal(summarize(cases).score < 1e-3, true, JSON.stringify(summarize(cases)));
  });

  it('the smear metric sees a tilt of the size the old pole margin had', () => {
    // Guard against a metric that reads zero for everything: the same scene,
    // looked at 0.01 rad off the pole, must smear the 1.3 m column by
    // ~13 mm, which is ~10 px at this zoom.
    const camera = orthoCamera();
    applyPreset(camera, 'top', 0);
    const t = camera.getTarget();
    const d = 5;
    camera.setPosition(t.x, t.y + d * Math.cos(0.01), t.z + d * Math.sin(0.01));
    const px = smearPx(camera, PRESET_AXIS.top);
    const pxPerMetre = 600 / (2 * camera.getOrthoSize());
    assert.ok(Math.abs(px - 1.3 * Math.sin(0.01) * pxPerMetre) < 0.05, `smear ${px} px`);
  });
});
