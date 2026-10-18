/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProjectionDepthReport, ProjectionDepthRow } from './projection-depth.gpu.js';
import { startViewerDevServer } from './viewer-dev-server.js';

let report: ProjectionDepthReport;

test.beforeAll(async ({ browser }, info) => {
  const server = await startViewerDevServer('projection-depth');
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(new URL('/oauth/autodesk/callback', server.url).href);
    const url = `/@fs/${fileURLToPath(new URL('./projection-depth.gpu.ts', import.meta.url))}`;
    report = await page.evaluate(async moduleUrl => {
      const probe: { runProjectionDepthWitness(): Promise<ProjectionDepthReport> } = await import(moduleUrl);
      return probe.runProjectionDepthWitness();
    }, url);
    const sources = ['projection-depth.fixture.ts', 'projection-depth.gpu.ts', '../../packages/renderer/src/shaders/main.wgsl.ts', '../../packages/renderer/src/shaders/depth-nudge.wgsl.ts'];
    const hashes = Object.fromEntries(sources.map(name => [name, createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex')]));
    await info.attach('paired-projection-depth', { body: JSON.stringify({
      source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }), hashes, pageErrors, ...report,
    }, null, 2), contentType: 'application/json' });
    expect(pageErrors).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.rows).toHaveLength(1440);
    for (const row of report.rows) {
      expect(row.otherPixels, `probe must be covered: ${JSON.stringify(row)}`).toBe(0);
      expect(row.frontPixels + row.rearPixels).toBe(64);
    }
  } finally { await page.close(); await server.close(); }
});

function requireFront(rows: ProjectionDepthRow[]) {
  expect(rows.length, 'nonempty witness cohort').toBeGreaterThan(0);
  const failures = rows.filter(row => row.frontPixels !== 64 || row.rearPixels !== 0);
  const summary = failures.map(({ family, samples, range, gap, angle, reverseDrawOrder, rearPixels }) =>
    ({ family, samples, range, gap, angle, reverseDrawOrder, rearPixels }));
  expect(summary, `${failures.length}/${rows.length} cases drew a farther opaque surface; full report is attached`).toEqual([]);
}

test('perspective keeps separated surfaces hidden at every paired orbit pose (#6729)', () => {
  requireFront(report.rows.filter(row => row.projection === 'perspective'));
});

test('zero-nudge control preserves geometric visibility in both projections (#6729)', () => {
  requireFront(report.rows.filter(row => row.mode === 'zero-nudge'));
});

test('orthographic 30mm and reduced-range controls preserve visibility (#6729)', () => {
  requireFront(report.rows.filter(row => row.projection === 'orthographic' && (row.gap === 0.03 || row.range === 5.201668158)));
});

// Intentionally exposes the remaining defect on the current production shader.
// Never invert this assertion to bless a known leak, skip it, or increase gap.
test('orthographic keeps 4mm surfaces hidden while orbiting larger scenes (#6729)', () => {
  requireFront(report.rows.filter(row => row.projection === 'orthographic' && row.mode === 'production' && row.gap === 0.004 && row.range > 5.201668158));
});
