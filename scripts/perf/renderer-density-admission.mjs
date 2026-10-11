/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6881: controlled raster inputs are not physical HiDPI/performance acceptance.
export const RENDERER_DENSITY_INPUTS = Object.freeze([1, 1.5, 2]);
// The witness performs nine point picks, including its three no-hit controls.
const EXPECTED_POINT_SAMPLES = 9;
const isUint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function requirePassedDensityReport(density, report) {
  if (report?.status !== 'passed' || report.system?.hardwareVerified !== true) {
    throw new Error(`Density ${density} witness did not pass on verified hardware: ${report?.status ?? 'absent'}; ${report?.reason ?? ''}`);
  }
}

/** Admit actual reports, never an empty comparison or incomplete readback. */
export function requireRendererDensityOracle(reports, samples) {
  if (!Array.isArray(samples)) throw new Error('Same-render depth samples are absent');
  if (!Array.isArray(reports) || reports.length !== RENDERER_DENSITY_INPUTS.length) {
    throw new Error('Every declared density must have a witness report');
  }
  for (const density of RENDERER_DENSITY_INPUTS) {
    const matching = reports.filter(row => row.density === density);
    if (matching.length !== 1) throw new Error(`Density ${density} must have exactly one report`);
    requirePassedDensityReport(density, matching[0].report);
    const measured = samples.filter(sample => sample.density === density);
    if (measured.length < EXPECTED_POINT_SAMPLES) {
      throw new Error(`Density ${density} has ${measured.length} depth samples; expected at least ${EXPECTED_POINT_SAMPLES}`);
    }
  }
  for (const sample of samples) {
    if (!RENDERER_DENSITY_INPUTS.includes(sample.density)
      || !Number.isInteger(sample.width) || sample.width <= 0
      || !Number.isInteger(sample.height) || sample.height <= 0
      || !Number.isInteger(sample.x) || sample.x < 0 || sample.x >= sample.width
      || !Number.isInteger(sample.y) || sample.y < 0 || sample.y >= sample.height
      || !isUint32(sample.encodedId) || !isUint32(sample.actual) || !isUint32(sample.oracle)) {
      throw new Error('A same-render depth sample is incomplete or outside its target');
    }
    if (sample.actual !== sample.oracle) {
      throw new Error('A production renderer pick differs from its same-render full-depth copy');
    }
  }
}

/** The live controller and CPU admission controls use this same execution path. */
export async function runRendererDensityControls({ window, document, runWitness, observeDepthCopies }) {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  const nativeDevicePixelRatio = window.devicePixelRatio;
  const reports = [], depthCopies = [];
  try {
    for (const density of RENDERER_DENSITY_INPUTS) {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: density });
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      canvas.style.cssText = 'display:block;width:640px;height:480px';
      document.body.append(canvas);
      try {
        const report = await runWitness(canvas, renderer => observeDepthCopies(renderer, depthCopies, density));
        reports.push({ density, report });
        requirePassedDensityReport(density, report);
      } finally { canvas.remove(); }
    }
  } finally {
    try {
      if (descriptor) Object.defineProperty(window, 'devicePixelRatio', descriptor);
      else delete window.devicePixelRatio;
    } finally {
      // The witness retires its renderer/device; join independent oracle maps
      // on failure too, while retaining their original rejection for admission.
      await Promise.allSettled(depthCopies);
    }
  }
  const sameRenderDepth = await Promise.all(depthCopies);
  requireRendererDensityOracle(reports, sameRenderDepth);
  return { nativeDevicePixelRatio, reports, sameRenderDepth };
}
