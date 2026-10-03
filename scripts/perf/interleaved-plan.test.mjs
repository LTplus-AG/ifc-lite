/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, immutableRef, requireIdentityPair, describeFamily, GRAPHICS_PROFILE, requireGraphicsProfile } from './interleaved-plan.mjs';

const row = sample => ({ ...sample, status: 'complete', identity: { complete: true, sha256: 'same' },
  graphics: { profile: GRAPHICS_PROFILE.profile, flags: [...GRAPHICS_PROFILE.flags] },
  runtime: { hardwareConcurrency: 4, crossOriginIsolated: true, sharedArrayBuffer: true,
    browserVersion: 'fixed', workerCount: 4, workerIds: [0, 1, 2, 3] },
  metrics: { metadataRenderReadyMs: sample.arm === 'candidate' ? 90 : 100 } });

test('#6537 immutable inputs reject moving refs and shell input', () => {
  assert.equal(immutableRef('a'.repeat(40)), 'a'.repeat(40));
  for (const value of ['main', 'latest', 'abc123', 'A'.repeat(40), 'a'.repeat(40) + '\n', '$(echo secret)', undefined]) {
    assert.throws(() => immutableRef(value), /immutable/);
  }
});
test('#6537 finite fixed cohort has one A/A and five alternating A/B pairs per family', () => {
  const samples = schedule();
  assert.equal(samples.length, 48);
  assert.equal(new Set(samples.map(sample => sample.id)).size, 48);
  for (const family of new Set(samples.map(sample => sample.family))) {
    const group = samples.filter(sample => sample.family === family);
    assert.equal(group.length, 12);
    assert.deepEqual(group.slice(0, 2).map(sample => sample.arm), ['base', 'base']);
    assert.deepEqual(group.slice(2).map(sample => sample.arm),
      ['base', 'candidate', 'candidate', 'base', 'base', 'candidate', 'candidate', 'base', 'base', 'candidate']);
  }
});
test('#6537 identity, completion, worker changes and A/A noise are terminal refusals', () => {
  const [a, b] = schedule().slice(0, 2).map(row);
  requireIdentityPair(a, b);
  assert.throws(() => requireIdentityPair(a, { ...b, status: 'refused' }), /incomplete/);
  assert.throws(() => requireIdentityPair(a, { ...b, identity: { complete: true, sha256: 'changed' } }), /identity mismatch/);
  assert.throws(() => requireIdentityPair(a, { ...b, runtime: { ...b.runtime, workerCount: 2, workerIds: [0, 1] } }), /census changed/);
  assert.throws(() => requireIdentityPair(a, { ...b, metrics: { metadataRenderReadyMs: 111 } }), /noise/);
  for (const value of [0, null, undefined, NaN, Infinity, -Infinity, '100']) {
    const invalid = sample => ({ ...sample, metrics: { metadataRenderReadyMs: value } });
    assert.throws(() => requireIdentityPair(invalid(a), invalid(b)), /full readiness/);
  }
  for (const key of ['sharedArrayBuffer', 'crossOriginIsolated', 'hardwareConcurrency', 'workerCount']) {
    const invalid = sample => ({ ...sample, runtime: { ...sample.runtime, [key]: key.endsWith('Count') || key === 'hardwareConcurrency' ? Infinity : false } });
    assert.throws(() => requireIdentityPair(invalid(a), invalid(b)), /default runtime census/);
  }
});
test('#6537 report requires complete family and reports unavailable phase instead of inventing one', () => {
  const samples = schedule().slice(0, 12).map(row);
  const result = describeFamily(samples);
  assert.equal(result.metadataRenderReadyMs.pairedPercent.length, 5);
  assert.ok(result.metadataRenderReadyMs.pairedPercent.every(value => Math.abs(value + 10) < 1e-9));
  assert.deepEqual(result.dataModelParseMs, { available: false });
  assert.throws(() => describeFamily(samples.slice(0, 10)), /twelve/);
});

test('#6737 missing or nonfinite phase values cannot fabricate paired improvements', () => {
  const valid = schedule().slice(0, 12).map(sample => ({ ...row(sample), metrics: {
    ...row(sample).metrics, dataModelParseMs: sample.arm === 'candidate' ? 80 : 100,
  } }));
  assert.ok(Math.abs(describeFamily(valid).dataModelParseMs.medianPercent + 20) < 1e-9);
  for (const arm of ['candidate', 'base']) for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, '80']) {
    const rows = valid.map(sample => sample.kind === 'AB' && sample.arm === arm
      ? { ...sample, metrics: { ...sample.metrics, dataModelParseMs: value } } : sample);
    assert.deepEqual(describeFamily(rows).dataModelParseMs, { available: false }, `${arm} invalid phase: ${value}`);
  }
});
test('#6537 paired samples require the same fixed declared graphics profile and exact flag array', () => {
  const [a, b] = schedule().slice(0, 2).map(row);
  requireIdentityPair(a, b);
  for (const graphics of [undefined, null, {}, { ...a.graphics, profile: 'original' },
    { ...a.graphics, flags: new Array(a.graphics.flags.length) },
    { ...a.graphics, flags: a.graphics.flags.slice(0, -1) },
    { ...a.graphics, flags: [...a.graphics.flags, '--enable-automation'] },
    { ...a.graphics, flags: a.graphics.flags.toReversed() },
    { ...a.graphics, flags: a.graphics.flags.map(flag => flag === '--use-vulkan=swiftshader' ? '--use-vulkan=native' : flag) }]) {
    assert.throws(() => requireIdentityPair(a, { ...b, graphics }), /graphics profile/);
    assert.throws(() => requireIdentityPair({ ...a, graphics }, { ...b, graphics }), /graphics profile/);
  }
  assert.deepEqual(requireGraphicsProfile(JSON.parse(JSON.stringify(a.graphics))), GRAPHICS_PROFILE);
  assert.throws(() => GRAPHICS_PROFILE.flags.push('--disable-webgpu-validation'), TypeError);
});
