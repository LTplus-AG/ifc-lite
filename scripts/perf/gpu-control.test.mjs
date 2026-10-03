/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CANVAS, PROFILES, ORIGINAL_FLAGS, COLORS, rgba, requirePixels, backendErrors, verdict, interpretation, canSignalOwnedGroup, requireCompletion, requireOwnedChrome } from './gpu-control.mjs';

function witness() {
  return { status: 'observed', events: [], observation: { frames: 120, activeMs: 15001 },
    colors: COLORS.map(color => ({ name: color.name, presentationFrames: 2, gpu: { submitted: true, rgba: [...color.bytes] },
      png: { ...CANVAS, center: [...color.bytes] } })) };
}
test('#6537 graphics profiles are fixed prospective arms, preserving original flags', () => {
  assert.deepEqual(PROFILES.map(profile => profile.name), ['original', 'corrected']);
  assert.deepEqual(PROFILES[1].args.slice(0, ORIGINAL_FLAGS.length), ORIGINAL_FLAGS);
  assert.equal(PROFILES[1].args.length, ORIGINAL_FLAGS.length + 3);
  assert.throws(() => PROFILES[0].args.push('--disable-webgpu-validation'), TypeError);
});
test('#6537 BGRA readback normalizes red and blue without swapping alpha', () => {
  assert.deepEqual(rgba('bgra8unorm', [0, 0, 255, 255]), COLORS[0].bytes);
  assert.deepEqual(rgba('bgra8unorm', [255, 0, 0, 255]), COLORS[1].bytes);
  assert.deepEqual(rgba('rgba8unorm', COLORS[1].bytes), COLORS[1].bytes);
  assert.throws(() => rgba('rgba16float', [0, 0, 1, 1]), /Unsupported/);
});
test('#6537 presentation requires all four exact channels, not submission alone', () => {
  requirePixels(COLORS[0].bytes, COLORS[0].bytes, 'red');
  assert.throws(() => requirePixels([255, 0, 0, 0], COLORS[0].bytes, 'red'), /mismatch/);
  assert.throws(() => requirePixels([255, 0, 0], COLORS[0].bytes, 'red'), /mismatch/);
  assert.equal(verdict(witness(), []), 'pixels-observed');
  const missing = witness(); missing.colors.pop(); assert.equal(verdict(missing, []), 'refused');
  const wrong = witness(); wrong.colors[1].png.center = COLORS[0].bytes;
  assert.equal(verdict(wrong, []), 'refused');
});
test('#6537 canvas dimensions and subsequent frame observation are mandatory', () => {
  for (const change of [row => { row.colors[0].png.width--; }, row => { row.observation.frames = 0; },
    row => { row.observation.activeMs = 14999; }, row => { row.colors[0].gpu.submitted = false; },
    row => { row.colors[0].presentationFrames = 1; }]) {
    const row = witness(); change(row); assert.equal(verdict(row, []), 'refused');
  }
});
test('#6537 backend failures and device/error deliveries refuse even with matching pixels', () => {
  const log = '[err] Could not find a SharedImageBackingFactory\n[err] VK_ERROR_DEVICE_LOST\nnormal Vulkan adapter selected\nERROR: unable to initialize Dawn';
  assert.equal(backendErrors(log).length, 3);
  assert.equal(verdict(witness(), backendErrors(log)), 'refused');
  for (const event of [{ kind: 'pageerror' }, { kind: 'crash' }, { kind: 'diagnostic-refusal' },
    { kind: 'console', type: 'error', text: 'GPU_DEVICE_LOST' }]) {
    const row = witness(); row.events.push(event); assert.equal(verdict(row, []), 'refused');
  }
});
test('#6537 two passing controls remain inconclusive about viewer failure', () => {
  const rows = ['original', 'corrected'].map(profile => ({ profile, status: 'pixels-observed' }));
  assert.match(interpretation(rows), /inconclusive/);
  rows[0].status = 'refused'; assert.match(interpretation(rows), /narrow graphics-environment/);
  rows[1].status = 'refused'; assert.match(interpretation(rows), /not qualified/);
  assert.throws(() => interpretation(rows.toReversed()), /ordered/);
});
test('#6537 abort cannot signal a reused PID or foreign process group', () => {
  const owner = { pid: 100, pgrp: 100, startTime: '123', state: 'S' };
  assert.equal(canSignalOwnedGroup(owner, { ...owner }), true);
  for (const current of [null, { ...owner, startTime: '124' }, { ...owner, pgrp: 99 },
    { ...owner, pid: 101 }, { ...owner, state: 'Z' }]) assert.equal(canSignalOwnedGroup(owner, current), false);
  assert.equal(canSignalOwnedGroup({ ...owner, pgrp: 99 }, owner), false);
});
test('#6537 final cancellation invalidates an otherwise complete pixel receipt', () => {
  const rows = ['original', 'corrected'].map(profile => ({ profile, status: 'pixels-observed' }));
  assert.equal(requireCompletion(rows), 'complete-controls');
  for (const signal of ['SIGINT', 'SIGTERM']) assert.throws(() => requireCompletion(rows, signal), /completion refused/);
  assert.throws(() => requireCompletion(rows.slice(0, 1)), /ordered/);
  assert.throws(() => requireCompletion([...rows, rows[1]]), /ordered/);
  assert.throws(() => requireCompletion([{ ...rows[0], status: 'pending' }, rows[1]]), /ordered/);
  assert.throws(() => requireCompletion([rows[0], { ...rows[1], status: 'refused' }]), /Corrected/);
});
test('#6537 command-line observation refuses ambiguity, foreign parents, renderer children and conflicting flags', () => {
  const main = { identity: { pid: 101, ppid: 100, startTime: '1' }, arguments: ['/opt/google/chrome/chrome', ...ORIGINAL_FLAGS] };
  assert.equal(requireOwnedChrome([main], 100, ORIGINAL_FLAGS), main);
  for (const records of [[main, { ...main, identity: { ...main.identity, pid: 102 } }],
    [{ ...main, identity: { ...main.identity, ppid: 99 } }],
    [{ ...main, arguments: [...main.arguments, '--type=gpu-process'] }]])
    assert.throws(() => requireOwnedChrome(records, 100, ORIGINAL_FLAGS), /Exactly one/);
  assert.throws(() => requireOwnedChrome([{ ...main, arguments: [...main.arguments, '--use-angle=default'] }], 100, ORIGINAL_FLAGS), /flag mismatch/);
  assert.throws(() => requireOwnedChrome([main], 100, PROFILES[1].args), /flag mismatch/);
  const corrected = { ...main, arguments: [main.arguments[0], '--enable-features=CDPScreenshotNewSurface', ...PROFILES[1].args] };
  assert.equal(requireOwnedChrome([corrected], 100, PROFILES[1].args), corrected);
  assert.throws(() => requireOwnedChrome([{ ...corrected, arguments: [...corrected.arguments, '--enable-features=Unknown'] }], 100, PROFILES[1].args), /flag mismatch/);
});
