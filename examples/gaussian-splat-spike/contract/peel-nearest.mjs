/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8564 option B judged against the K-layer peel witness: per texel (1x pixel or 4x
// sample), the analytic count of transparent layers in front of opaque decides what
// must hold. <= 1 layer: equal to the independent reference and to the K-layer
// candidate. >= 2 layers anywhere: the frame reports `multiple`. Pure module.
import { glassDepth, SAMPLE_POSITIONS, sampleReference } from './peel-scene.mjs';

const orderKey = order => order.map(e => e.kind + e.index).join();

/**
 * Samples whose far-to-near order changes if glass depth is evaluated at the x-mirrored
 * sample position (what SwiftShader's fixed-function 4x depth does, see peel-probe.mjs).
 */
export function mirrorSensitive(scene, samples) {
  const sensitive = new Uint8Array(scene.size * scene.size * samples);
  if (samples === 1) return sensitive;
  for (let y = 0; y < scene.size; y++) for (let x = 0; x < scene.size; x++) SAMPLE_POSITIONS[samples].forEach(([ox, oy], s) => {
    const { order, elements, opaqueDepth } = sampleReference(scene, x, y, [ox, oy]);
    const X = x + 1 - ox - scene.R, Y = y + oy - scene.R;
    // Glass depth moves to the mirrored position everywhere it is tested: against splats and against opaque.
    const mirrored = elements.map(e => e.kind === 'glass' ? { ...e, z: glassDepth(scene, e.index, X, Y) } : e).filter(e => e.z > opaqueDepth)
      .sort((a, b) => a.z - b.z || (a.kind === b.kind ? 0 : a.kind === 'splat' ? -1 : 1) || a.index - b.index);
    if (orderKey(mirrored) !== orderKey(order)) sensitive[(y * scene.size + x) * samples + s] = 1;
  });
  return sensitive;
}

/** Per-texel layer counts, in the unpacked layout (width size * samples). */
export function layerCounts(scene, samples) {
  const counts = new Uint8Array(scene.size * scene.size * samples);
  for (let y = 0; y < scene.size; y++) for (let x = 0; x < scene.size; x++) SAMPLE_POSITIONS[samples].forEach((offset, s) => {
    counts[(y * scene.size + x) * samples + s] = sampleReference(scene, x, y, offset).layers.length;
  });
  return counts;
}

/** Differences of `candidate` from `reference`, split by layer count. */
export function compareByLayers(reference, candidate, counts, sensitive = null) {
  if (reference.length !== candidate.length || reference.length !== counts.length * 4) throw new Error('image sizes differ');
  const tally = () => ({ texels: 0, differentTexels: 0, maxDelta: 0, redTexels: 0, unexplainedTexels: 0, unexplainedMaxDelta: 0 });
  const result = { single: tally(), multiple: tally() };
  for (let t = 0; t < counts.length; t++) {
    const bucket = counts[t] <= 1 ? result.single : result.multiple;
    bucket.texels++;
    if (candidate[t * 4] > 0) bucket.redTexels++;
    let delta = 0;
    for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(reference[t * 4 + c] - candidate[t * 4 + c]));
    if (delta) { bucket.differentTexels++; bucket.maxDelta = Math.max(bucket.maxDelta, delta); }
    if (delta && !sensitive?.[t]) { bucket.unexplainedTexels++; bucket.unexplainedMaxDelta = Math.max(bucket.unexplainedMaxDelta, delta); }
  }
  return result;
}

/**
 * Verdict for one option-B case. `tolerance` bounds per-channel noise where a backend
 * needs it (0 = exact). `control`: the split is disabled, so in single-pane scenes it
 * must miss the reference. `conformantDepth: false` (the probe found fixed-function 4x
 * depth at mirrored sample positions) accepts only mismatches that mirroring explains,
 * and the verdict says so: that is a platform result, not exactness.
 */
export function judgeNearest({ toReference, toPeel, layers, counts, control = false, tolerance = 0, panes = 'all', conformantDepth = true, referenceRepeatable = null }) {
  const multipleExpected = counts.some(count => count >= 2);
  const failures = [];
  const within = bucket => conformantDepth ? bucket.maxDelta <= tolerance : bucket.unexplainedMaxDelta <= tolerance;
  if (control) {
    if (panes === 'single' && toReference.single.maxDelta <= tolerance) failures.push('negative control (split off) matched the reference on single-layer texels');
  } else {
    if (toReference.single.redTexels === 0) failures.push('no red splat texels on single-layer texels');
    // The K-layer peel is the decided reference (#8564). The independent per-sample reference must also
    // agree, unless a repeat render of it differs from itself in this case (a nondeterministic reference).
    if (!toPeel) failures.push('no K-layer peel image for this case');
    else if (!within(toPeel.single)) failures.push(`single-layer texels differ from the K-layer peel (max ${toPeel.single.maxDelta})`);
    if (!within(toReference.single) && referenceRepeatable !== false) failures.push(`single-layer texels differ from the independent reference (max ${toReference.single.maxDelta})`);
  }
  const expected = multipleExpected ? 'multiple' : 'single';
  if (layers.reported !== expected) failures.push(`reported ${layers.reported} layers, analytic ${expected}`);
  const platformExplained = !conformantDepth && !control && toReference.single.differentTexels > 0;
  const referenceUnstable = !control && referenceRepeatable === false && toReference.single.differentTexels > 0;
  return { pass: failures.length === 0, failures, exact: !control && toReference.single.differentTexels === 0, platformExplained, referenceUnstable,
    multipleExpected, beyondExactTexels: counts.filter(count => count >= 2).length };
}
