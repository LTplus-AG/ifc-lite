/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 browser witness: drives the real viewer Renderer (its device, frame,
// MSAA targets and colour capture) with the internal, unqualified Gaussian
// adapter. One fresh renderer per scene; every teardown is audited.
import { closeRenderer, consoleErrors, openRenderer, setPhase, plain } from './native-adapter-witness-lib.mjs';
import { SCENES } from './native-adapter-witness-scenes.mjs';
import { GLASS_SCENES, forceSingleSample } from './native-adapter-witness-glass.mjs';

async function runScene(name, scene, images) {
  const restore = scene.samples === 1 ? forceSingleSample() : null;
  let h;
  try { h = await openRenderer(name); } finally { restore?.(); }
  const result = { adapterAvailable: h.adapter !== null };
  try {
    Object.assign(result, await scene(h));
  } catch (error) {
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  }
  result.captures = h.captures;
  result.deferredFrames = h.deferredFrames;
  result.lifetime = await closeRenderer(h);
  Object.assign(images, h.images);
  return result;
}

async function run() {
  if (!navigator.gpu) throw new Error('WebGPU required; no skip');
  const adapter = await navigator.gpu.requestAdapter();
  const environment = {
    userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
    canvasFormat: navigator.gpu.getPreferredCanvasFormat(),
    adapterInfo: adapter?.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null } : null,
  };
  const scenes = {}, images = {};
  const only = new URLSearchParams(location.search).get('scenes')?.split(',');
  for (const [name, scene] of Object.entries({ ...SCENES, ...GLASS_SCENES })) {
    if (only && !only.includes(name)) continue;
    document.querySelector('#status').textContent = `Running ${name}…`;
    scenes[name] = await runScene(name, scene, images);
  }
  setPhase('done');
  const adapterAvailable = Object.values(scenes).every(scene => scene.adapterAvailable);
  return { issue: 8564, productionReady: false, qualification: 'internal-unqualified', adapterAvailable, environment,
    scenes, images, consoleErrors: plain(consoleErrors) };
}

window.nativeAdapterWitness = run().then(result => ({ result }), error => ({ error: error instanceof Error ? error.stack : String(error) }));
window.nativeAdapterWitness.then(outcome => {
  const summary = outcome.result ? { ...outcome.result, images: Object.keys(outcome.result.images) } : outcome;
  document.querySelector('#status').textContent = outcome.error ? 'Failed' : 'Finished (judged by validate-native-adapter.mjs)';
  document.querySelector('#result').textContent = JSON.stringify(summary, null, 2);
});
