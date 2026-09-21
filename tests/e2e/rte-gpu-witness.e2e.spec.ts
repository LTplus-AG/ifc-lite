/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opt-in #5049 hardware acceptance. This test never accepts SwiftShader:
 * set RTE_GPU_WITNESS=1 only on a machine with a real WebGPU adapter.
 */

import { expect, test } from '@playwright/test';

interface WitnessReport {
  status: 'pending' | 'passed' | 'skipped' | 'failed';
  reason?: string;
  system: { adapter: { vendor?: string; architecture?: string } | null; devicePixelRatio: number; hardwareVerified: boolean };
  evidence?: {
    canvasPixels: { width: number; height: number };
    pickPixel: { x: number; y: number };
    texturedPick: { expressId: number; modelIndex?: number } | null;
    instancedPick: { expressId: number } | null;
    pointPick: { expressId: number } | null;
    largeExtentPick: { expressId: number } | null;
    highlightPixels: { changedPixels: number; maxChannelDelta: number } | null;
    shadowPixels: { changedPixels: number; maxChannelDelta: number } | null;
    pointCropClick: boolean;
    pointCropRectangle: boolean;
    sourceResidualMetres: number;
    pickResidualMetres: number | null;
    CPUAndGpuAgree: boolean;
    snapResidualMetres: number | null;
    measurementResidualMetres: number | null;
    provenanceStable: boolean;
    families: Record<string, boolean>;
    clippedPick: boolean;
    sectionPick: boolean;
    screenshotBytes: number;
    diagnostics: { gpuErrors: number; errors: number };
  };
}

declare global {
  interface Window {
    __ifc_lite_rte_gpu_witness__?: WitnessReport;
  }
}

test('production RTE GPU witness at 5,000 km (#5049)', async ({ page }, info) => {
  test.skip(process.env.RTE_GPU_WITNESS !== '1', 'Set RTE_GPU_WITNESS=1 on a real WebGPU adapter; CI SwiftShader is not acceptance evidence.');
  await page.goto('/rte-gpu-witness');
  await expect(page.getByRole('heading', { name: 'RTE GPU witness (#5049)' })).toBeVisible();
  await page.waitForFunction(() => {
    const status = window.__ifc_lite_rte_gpu_witness__?.status;
    return status === 'passed' || status === 'skipped' || status === 'failed';
  }, undefined, { timeout: 120_000 });
  const report = await page.evaluate(() => window.__ifc_lite_rte_gpu_witness__);
  if (!report) throw new Error('RTE GPU witness did not publish a report.');
  await info.attach('production RTE GPU witness report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  if (report.status === 'skipped') test.skip(true, report.reason ?? 'Hardware adapter was not available.');
  expect(report.status, report.reason).toBe('passed');
  expect(report.system.adapter?.vendor, 'real adapter vendor').toBeTruthy();
  expect(report.system.hardwareVerified, 'positively identified hardware adapter').toBe(true);
  expect(report.evidence).toBeDefined();
  expect(report.evidence?.canvasPixels).toEqual({ width: 640, height: 480 });
  expect(report.evidence?.pickPixel).toEqual({ x: 320, y: 240 });
  expect(report.evidence?.sourceResidualMetres).toBeLessThanOrEqual(0.03);
  expect(report.evidence?.pickResidualMetres).not.toBeNull();
  expect(report.evidence?.pickResidualMetres).toBeLessThanOrEqual(0.03);
  expect(report.evidence?.CPUAndGpuAgree).toBe(true);
  expect(report.evidence?.snapResidualMetres).not.toBeNull();
  expect(report.evidence?.measurementResidualMetres).toBeLessThanOrEqual(0.03);
  expect(report.evidence?.provenanceStable).toBe(true);
  expect(report.evidence?.texturedPick).toMatchObject({ expressId: 102, modelIndex: 12 });
  expect(report.evidence?.instancedPick).toMatchObject({ expressId: 103 });
  expect(report.evidence?.pointPick).toMatchObject({ expressId: 105 });
  expect(report.evidence?.largeExtentPick).toMatchObject({ expressId: 104 });
  expect(report.evidence?.highlightPixels?.changedPixels).toBeGreaterThan(0);
  expect(report.evidence?.shadowPixels?.changedPixels).toBeGreaterThan(0);
  expect(Object.values(report.evidence?.families ?? {}), 'every named production renderer family is evidenced').not.toContain(false);
  expect(report.evidence?.clippedPick).toBe(true);
  expect(report.evidence?.pointCropClick, 'point click obeys crop').toBe(true);
  expect(report.evidence?.pointCropRectangle, 'point marquee obeys crop').toBe(true);
  expect(report.evidence?.sectionPick).toBe(true);
  expect(report.evidence?.screenshotBytes).toBeGreaterThan(100);
  expect(report.evidence?.diagnostics).toEqual({ gpuErrors: 0, errors: 0 });
});
