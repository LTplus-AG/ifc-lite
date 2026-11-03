/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { PerspectiveDistanceReport } from './perspective-distance-depth.gpu.js';
import {
  MAX_DEPTH_NUDGE_HASH, PERSPECTIVE_DEPTH_NUDGE_PER_STEP, PERSPECTIVE_MAX_DEPTH_NUDGE_METRES,
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

test('the shader moves no surface more than the bound, at any distance or camera target (#7955)', () => {
  expect(report.shifts.length).toBeGreaterThan(0);
  const knee = PERSPECTIVE_MAX_DEPTH_NUDGE_METRES / (MAX_DEPTH_NUDGE_HASH * PERSPECTIVE_DEPTH_NUDGE_PER_STEP);
  for (const row of report.shifts) {
    const pose = `${row.distance} m / ${row.angle}° / ${row.target}`;
    // Depth32float read-back noise: a few float ulps of near / depth.
    const tolerance = 4e-7 * row.depth + 1e-6;
    const expected = MAX_DEPTH_NUDGE_HASH * Math.min(PERSPECTIVE_DEPTH_NUDGE_PER_STEP * row.depth, PERSPECTIVE_MAX_DEPTH_NUDGE_METRES / MAX_DEPTH_NUDGE_HASH);
    expect(row.shift, `${pose}: within the bound`).toBeLessThanOrEqual(PERSPECTIVE_MAX_DEPTH_NUDGE_METRES + tolerance);
    // Near the camera the unbounded nudge, unchanged; past the knee exactly the bound.
    expect(Math.abs(row.shift - expected), `${pose}: ${row.shift} m vs ${expected} m (knee ${knee.toFixed(1)} m)`).toBeLessThanOrEqual(tolerance + 0.02 * expected);
  }
  // The bound follows each surface's own depth, not the orbit target.
  for (const row of report.shifts.filter(r => r.target === 'near-camera')) {
    const twin = report.shifts.find(r => r.target === 'on-facade' && r.distance === row.distance && r.angle === row.angle)!;
    expect(Math.abs(row.shift - twin.shift), `${row.distance} m / ${row.angle}°: same shift with the target 5 m ahead`).toBeLessThanOrEqual(4e-7 * row.depth + 1e-6);
  }
});

/**
 * Coplanar ranking past the near regime (about 8 m). Two hashes `delta` apart
 * are only `delta / 255 * bound` apart in depth there, so close hashes lose
 * their order to depth noise with distance (depth-nudge.wgsl.ts). Measured on NVIDIA
 * (lovelace, Vulkan) and SwiftShader in depth24plus-stencil8 and
 * depth32float-stencil8, with opposite triangulations; these are the claims
 * that held with margin on all of them. Any separation resolved within 10 m
 * before #7955 and still does.
 */
const COPLANAR_CLAIMS = [
  { maxDistance: 30, minDelta: 1 },
  { maxDistance: 100, minDelta: 8 },
  { maxDistance: 300, minDelta: 32 },
] as const;

for (const { maxDistance, minDelta } of COPLANAR_CLAIMS) {
  test(`coplanar faces whose hashes differ by ${minDelta} or more stay ranked up to ${maxDistance} m (#7955)`, () => {
    const rows = report.coplanar.filter(row => row.mesh === 'fine' && row.distance <= maxDistance && row.delta >= minDelta);
    expect(rows.length).toBeGreaterThan(0);
    const mixed = rows.filter(row => row.frontPixels !== 64)
      .map(({ samples, distance, delta, angle, reverseDrawOrder, frontPixels, rearPixels }) => ({ samples, distance, delta, angle, reverseDrawOrder, frontPixels, rearPixels }));
    expect(mixed, `${mixed.length}/${rows.length} coplanar poses did not resolve to the higher-ranked entity`).toEqual([]);
  });
}

/**
 * The same, for two-triangle squares whose triangles reach from beside the
 * camera to twice the distance (long slabs and walls). The nudge is exact per
 * pixel, but on SwiftShader the depth noise of such grazing triangles exceeds
 * the bounded separation sooner; at 70 degrees even the unbounded nudge needed
 * a separation of 16 to 32 there, so only views up to 45 degrees are pinned.
 */
const COARSE_CLAIMS = [
  { maxDistance: 10, minDelta: 1 },
  { maxDistance: 100, minDelta: 16 },
  { maxDistance: 300, minDelta: 64 },
] as const;

for (const { maxDistance, minDelta } of COARSE_CLAIMS) {
  test(`coplanar long triangles whose hashes differ by ${minDelta} or more stay ranked up to ${maxDistance} m, up to 45° (#7955)`, () => {
    const rows = report.coplanar.filter(row => row.mesh === 'coarse' && row.angle <= 45 && row.distance <= maxDistance && row.delta >= minDelta);
    expect(rows.length).toBeGreaterThan(0);
    const mixed = rows.filter(row => row.frontPixels !== 64)
      .map(({ samples, distance, delta, angle, reverseDrawOrder, frontPixels, rearPixels }) => ({ samples, distance, delta, angle, reverseDrawOrder, frontPixels, rearPixels }));
    expect(mixed, `${mixed.length}/${rows.length} coplanar poses did not resolve to the higher-ranked entity`).toEqual([]);
  });
}
