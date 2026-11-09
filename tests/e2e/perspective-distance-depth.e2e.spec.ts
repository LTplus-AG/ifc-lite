/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { PerspectiveDistanceReport } from './perspective-distance-depth.gpu.js';
import {
  PERSPECTIVE_DEPTH_NUDGE_LEVELS, PERSPECTIVE_DEPTH_NUDGE_PER_LEVEL, PERSPECTIVE_MAX_DEPTH_NUDGE_RELATIVE,
} from '../../packages/renderer/src/shaders/depth-nudge.wgsl.js';
import { startViewerDevServer } from './viewer-dev-server.js';

let report: PerspectiveDistanceReport;

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(600_000);
  const server = await startViewerDevServer('perspective-distance-depth');
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(new URL('/oauth/autodesk/callback', server.url).href);
    const url = `/@fs/${fileURLToPath(new URL('./perspective-distance-depth.gpu.ts', import.meta.url))}`;
    report = await page.evaluate(async moduleUrl => {
      const probe: { runPerspectiveDistanceWitness(): Promise<PerspectiveDistanceReport> } = await import(moduleUrl);
      return probe.runPerspectiveDistanceWitness();
    }, url);
    const excluded = report.separated.filter(row => row.reference.frontPixels !== 64)
      .map(row => ({ ...row, reason: 'zero-nudge reference does not resolve this gap on this adapter' }));
    await info.attach('perspective-distance-depth', { body: JSON.stringify({ pageErrors, excluded, ...report }, null, 2), contentType: 'application/json' });
    expect(pageErrors).toEqual([]);
    expect(report.errors).toEqual([]);
    for (const row of [...report.separated, ...report.coplanar]) expect(row.otherPixels, `probe must be covered: ${JSON.stringify(row)}`).toBe(0);
  } finally { await page.close(); await server.close(); }
});

test('a facade panel 5 mm or more in front of a wall stays visible when zoomed out, whatever the camera target (#7955)', () => {
  // Judge only poses the geometry itself resolves: the same pose with the
  // nudge removed must draw the panel. Excluded poses are attached with that reason.
  const judged = report.separated.filter(row => row.reference.frontPixels === 64);
  expect(judged.length, 'the zero-nudge reference resolves nearly every pose').toBeGreaterThanOrEqual(report.separated.length * 0.9);
  const failures = judged.filter(row => row.frontPixels !== 64)
    .map(({ samples, distance, gap, angle, target, reverseDrawOrder, near, rearPixels }) => ({ samples, distance, gap, angle, target, reverseDrawOrder, near, rearPixels }));
  expect(failures, `${failures.length}/${judged.length} poses drew the wall over the panel in front of it`).toEqual([]);
});

test('the shader moves no surface more than the level bound, at any distance or camera target (#7955)', () => {
  expect(report.shifts.length).toBeGreaterThan(0);
  for (const row of report.shifts) {
    const pose = `${row.distance} m / ${row.angle}° / ${row.target}`;
    // Depth32float read-back noise: a few float ulps of near / depth.
    const tolerance = 4e-7 * row.depth + 1e-6;
    // Reverse-Z NDC depth near / d, scaled by 1 + k: the surface lands at d / (1 + k).
    const expected = row.depth - row.depth / (1 + PERSPECTIVE_MAX_DEPTH_NUDGE_RELATIVE);
    expect(Math.abs(row.shift - expected), `${pose}: ${row.shift} m vs ${expected} m`).toBeLessThanOrEqual(tolerance);
  }
  // 100 m: under 2 mm, against 25 mm before #7955.
  for (const row of report.shifts.filter(r => r.distance === 100)) expect(row.shift).toBeLessThan(0.002);
  // Relative to each surface's own depth, not the orbit target.
  for (const row of report.shifts.filter(r => r.target === 'near-camera')) {
    const twin = report.shifts.find(r => r.target === 'on-facade' && r.distance === row.distance && r.angle === row.angle)!;
    expect(Math.abs(row.shift - twin.shift), `${row.distance} m / ${row.angle}°: same shift with the target 5 m ahead`).toBeLessThanOrEqual(4e-7 * row.depth + 1e-6);
  }
});

/**
 * Coplanar ranking. The nudge is relative and float depth noise is relative,
 * so one level separates two entities alike at every distance. Measured on
 * NVIDIA (lovelace, Vulkan) and SwiftShader with opposite triangulations;
 * these are the claims that held with margin on both. Entities on the same
 * level (hashes within one level) are not ranked: draw order and depth noise
 * decide, as for two equal hashes before #7955.
 */
test(`coplanar faces one nudge level or more apart stay ranked up to 300 m (${PERSPECTIVE_DEPTH_NUDGE_LEVELS} levels, #7955)`, () => {
  const rows = report.coplanar.filter(row => row.mesh === 'fine' && row.levelDelta >= 1);
  expect(rows.length).toBeGreaterThan(0);
  const mixed = rows.filter(row => row.frontPixels !== 64)
    .map(({ samples, distance, delta, levelDelta, angle, reverseDrawOrder, frontPixels, rearPixels }) => ({ samples, distance, delta, levelDelta, angle, reverseDrawOrder, frontPixels, rearPixels }));
  expect(mixed, `${mixed.length}/${rows.length} coplanar poses did not resolve to the higher-ranked entity`).toEqual([]);
});

/**
 * The same, for two-triangle squares whose triangles reach from beside the
 * camera to twice the distance (long slabs and walls). SwiftShader's depth
 * noise on such triangles is larger: at 45 degrees it needed 2e-6 relative
 * separation (one level of 5e-7 never ranked, two failed 4 of 28 poses), as
 * the per-fragment attempt needed 1.25e-6 to 1.7e-6 there. At 70 degrees even
 * the unbounded nudge needed 16 to 32 hashes, so only views up to 45 degrees
 * are pinned.
 */
const COARSE_MIN_LEVELS = Math.ceil(2e-6 / PERSPECTIVE_DEPTH_NUDGE_PER_LEVEL - 1e-9);
test(`coplanar long triangles ${COARSE_MIN_LEVELS} nudge levels or more apart stay ranked up to 300 m, up to 45° (#7955)`, () => {
  const rows = report.coplanar.filter(row => row.mesh === 'coarse' && row.angle <= 45 && row.levelDelta >= COARSE_MIN_LEVELS);
  expect(rows.length).toBeGreaterThan(0);
  const mixed = rows.filter(row => row.frontPixels !== 64)
    .map(({ samples, distance, delta, levelDelta, angle, reverseDrawOrder, frontPixels, rearPixels }) => ({ samples, distance, delta, levelDelta, angle, reverseDrawOrder, frontPixels, rearPixels }));
  expect(mixed, `${mixed.length}/${rows.length} coplanar poses did not resolve to the higher-ranked entity`).toEqual([]);
});

/**
 * MSAA at creases. The nudge stays in the vertex stage, so depth is
 * fixed-function, per sample: where two faces cross inside a pixel each sample
 * keeps its own depth and the pixel blends, as with the nudge removed. The
 * control writes one depth per pixel (frag_depth, as the first #7955 attempt
 * did) and must lose those blends, or the witness could not see the regression.
 */
test('creases keep per-sample depth at 4x MSAA: pixels where two faces cross still blend (#7955)', () => {
  const rows = report.creases;
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.reference.mixedPixels, `fixed-function depth blends the crease: ${JSON.stringify(row)}`).toBeGreaterThanOrEqual(32);
  const production = rows.filter(row => row.variant === 'production');
  const aliased = production.filter(row => row.mixedPixels < 0.75 * row.reference.mixedPixels || row.differingPixels > 0.1 * row.reference.mixedPixels);
  expect(aliased, `${aliased.length}/${production.length} crease poses lost per-sample depth`).toEqual([]);
  const control = rows.filter(row => row.variant === 'pixel-centre');
  const blended = control.filter(row => row.mixedPixels >= 0.25 * row.reference.mixedPixels);
  expect(blended, 'the one-depth-per-pixel control aliases the crease').toEqual([]);
});
