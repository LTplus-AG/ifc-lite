/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8564 option B witness logic, GPU-free: per-texel judging against the K-layer peel,
// the SwiftShader mirrored-depth attribution, the single-pane scene's layer bound, the
// affine glass reference and the luma patch hook stripping.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildScene } from '../contract/peel-scene.mjs';
import { compareByLayers, judgeNearest, layerCounts, mirrorSensitive } from '../contract/peel-nearest.mjs';
import { glassOverSplats } from '../contract/native-adapter-glass-reference.mjs';
import { depthConventionRendererHash, publishedShadersHash, readDepthConventionRenderer, readPublishedShaders, stripDepthIntervalHook } from '../depth-patch.mjs';
import { createHash } from 'node:crypto';

const image = texels => new Uint8Array(texels.flat());

test('the single-pane peel scene has at most one transparent layer per sample, the full scene has more', () => {
  for (const projection of ['orthographic', 'perspective']) for (const samples of [1, 4]) {
    assert.ok(layerCounts(buildScene(24, projection, { panes: 'single' }), samples).every(count => count <= 1));
    assert.ok(layerCounts(buildScene(24, projection), samples).some(count => count >= 2));
  }
});

test('option B is judged per texel: single-layer texels exact, multi-layer frames must report multiple', () => {
  const reference = image([[200, 0, 0, 255], [0, 50, 0, 255], [9, 9, 9, 255]]);
  const exact = image([[200, 0, 0, 255], [0, 50, 0, 255], [1, 1, 1, 255]]); // differs only on the 2-layer texel
  const counts = new Uint8Array([1, 0, 2]);
  const toReference = compareByLayers(reference, exact, counts);
  assert.deepEqual([toReference.single.differentTexels, toReference.multiple.differentTexels], [0, 1]);
  assert.equal(judgeNearest({ toReference, toPeel: toReference, layers: { reported: 'multiple' }, counts }).pass, true);
  assert.match(judgeNearest({ toReference, toPeel: toReference, layers: { reported: 'single' }, counts }).failures.join(), /reported single layers, analytic multiple/);
  assert.match(judgeNearest({ toReference, toPeel: null, layers: { reported: 'multiple' }, counts }).failures.join(), /no K-layer peel image/);
  const off = compareByLayers(reference, image([[199, 0, 0, 255], [0, 50, 0, 255], [9, 9, 9, 255]]), counts);
  assert.match(judgeNearest({ toReference: off, toPeel: toReference, layers: { reported: 'multiple' }, counts }).failures.join(), /differ from the independent reference/);
  assert.equal(judgeNearest({ toReference: off, toPeel: toReference, layers: { reported: 'multiple' }, counts, tolerance: 1 }).pass, true);
  // A reference that differs from its own repeat cannot fail option B; equality with the K-layer peel still must hold.
  const unstable = judgeNearest({ toReference: off, toPeel: toReference, layers: { reported: 'multiple' }, counts, referenceRepeatable: false });
  assert.equal(unstable.pass, true);
  assert.equal(unstable.referenceUnstable, true);
  assert.equal(judgeNearest({ toReference: off, toPeel: off, layers: { reported: 'multiple' }, counts, referenceRepeatable: false }).pass, false);
  // The split-off control must miss single-layer texels in single-pane scenes.
  assert.match(judgeNearest({ toReference, toPeel: null, layers: { reported: 'multiple' }, counts, control: true, panes: 'single' }).failures.join(), /negative control/);
});

test('non-conformant fixed-function depth accepts only mismatches the mirrored sample positions explain', () => {
  const scene = buildScene(24, 'orthographic', { panes: 'single' });
  const sensitive = mirrorSensitive(scene, 4), counts = layerCounts(scene, 4);
  const at = sensitive.indexOf(1), clean = sensitive.indexOf(0);
  assert.ok(at >= 0 && clean >= 0, 'the tilted pane crosses splats near some samples');
  assert.ok(mirrorSensitive(scene, 1).every(v => v === 0));
  const reference = new Uint8Array(counts.length * 4).fill(10);
  const explained = reference.slice(); explained[at * 4] = 90; explained[at * 4 + 1] = 1;
  const unexplained = explained.slice(); unexplained[clean * 4] = 90;
  const verdict = flip => { const c = compareByLayers(reference, flip, counts, sensitive); return judgeNearest({ toReference: c, toPeel: c, layers: { reported: 'single' }, counts, conformantDepth: false }); };
  assert.equal(verdict(explained).pass, true);
  assert.equal(verdict(explained).platformExplained, true);
  assert.equal(verdict(unexplained).pass, false);
});

test('the affine glass reference: B0 + (B1 - B0) * A / 255 per channel', () => {
  const frame = rgba => ({ width: 1, height: 1, rgba: new Uint8Array(rgba) });
  const region = { bounds: [0, 0, 0, 0], contains: () => true, describe: 'pixel' };
  // Glass alpha 0.4 of colour 100: over 0 -> 40, over 255 -> 193; over splat 200 -> 160.
  const result = glassOverSplats(frame([160, 40, 40, 255]), frame([40, 40, 40, 255]), frame([193, 193, 193, 255]), frame([200, 0, 0, 255]), region);
  assert.equal(result.overTolerance, 0);
  assert.equal(result.splatPixels, 1);
  assert.equal(glassOverSplats(frame([200, 0, 0, 255]), frame([40, 40, 40, 255]), frame([193, 193, 193, 255]), frame([200, 0, 0, 255]), region).overTolerance, 1,
    'the splat drawn over the glass misses the reference');
});

test('stripping the #8564 depth-interval hook restores the recorded upstream bytes', async () => {
  const dist = fileURLToPath(new URL('../../../packages/renderer/node_modules/@luma.gl/splats/dist/', import.meta.url));
  const sha256 = text => createHash('sha256').update(text).digest('hex');
  const shaders = await readFile(dist + 'splat-shaders.js', 'utf8'), renderer = await readFile(dist + 'splat-renderer.js', 'utf8');
  assert.ok(shaders.includes('getSplatDepthIntervalWGSLShader') && renderer.includes('depthIntervalSamples'), 'the installed patch carries the hook');
  assert.equal(sha256(stripDepthIntervalHook(shaders)), publishedShadersHash);
  assert.equal(sha256(stripDepthIntervalHook(renderer)), depthConventionRendererHash);
  assert.equal(sha256(await readPublishedShaders(dist + 'splat-shaders.js')), publishedShadersHash);
  assert.equal(sha256(await readDepthConventionRenderer(dist + 'splat-renderer.js')), depthConventionRendererHash);
});
