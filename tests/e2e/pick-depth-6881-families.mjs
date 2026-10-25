/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reuse the repository's explicit production-renderer raster invariant. It
// covers flat/textured meshes, instances, points, crops and a 5,000 km origin;
// it does not pretend its authored mesh fixture is an IFC authoring-tool model.
import { runWitness } from '../../apps/viewer/src/e2e/RteGpuWitness.tsx';
import { installOracle } from './pick-depth-6881-observer.mjs';

export async function runFamilyControls() {
  const canvas = document.querySelector('#witness');
  let api;
  let restoreCapture;
  try {
    const report = await runWitness(canvas, renderer => {
      // The standalone witness waits for GPU completion before requesting a
      // screenshot. WebGPU may already have discarded its presentation image
      // then (#6709). Preserve the actual full-size color frame synchronously
      // after each real render, as the viewer capture gateway does. Keep every
      // existing raster assertion; this observer is untimed and test-only.
      const render = renderer.render, capture = renderer.captureScreenshot;
      let image;
      renderer.render = function(...args) {
        const result = render.apply(this, args);
        image = canvas.toDataURL('image/png');
        return result;
      };
      renderer.captureScreenshot = async () => {
        if (!image) throw Error('Family screenshot requested before an observed render');
        return image;
      };
      restoreCapture = () => { renderer.render = render; renderer.captureScreenshot = capture; };
      installOracle({ renderer }); api = globalThis.__6881;
    });
    if (!api) throw Error('Production renderer witness did not install its observer');
    await api.drain();
    const samples = api.samples.slice();
    if (report.status !== 'passed' || !report.system.hardwareVerified || samples.length !== 9
      || !['mesh', 'instanced', 'point'].every(kind => samples.some(row => row.kind === kind && row.actual))) {
      throw Error(`Production family witness incomplete: ${JSON.stringify({ report, samples })}`);
    }
    return { report, samples };
  } finally {
    restoreCapture?.();
    if (api) await api.retire();
  }
}
