/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilerFixture } from './lib/exact-route-unit-fixture.mjs';
import { compilerEnvironment, compilerEvidence } from './exact-route-compiler.mjs';
for (const key of ['CARGO_PROFILE_SERVER_RELEASE_PANIC', 'CARGO_PROFILE_SERVER_RELEASE_DEBUG_ASSERTIONS',
  'CARGO_PROFILE_RELEASE_OPT_LEVEL', 'CARGO_PROFILE_DEV_BUILD_OVERRIDE_DEBUG', 'CARGO_PROFILE_FUTURE_UNKNOWN_OPTION']) {
  test(`every profile override refuses, including empty values: ${key}`, () => {
    assert.throws(() => compilerEnvironment({ [key]: '1' }));
    assert.throws(() => compilerEnvironment({ [key]: '' }));
  });
}
test('flags and target compiler settings are recorded without discarding values', () => {
  const env = { RUSTFLAGS: '-C opt-level=3', CARGO_ENCODED_RUSTFLAGS: '-C\x1fpanic=unwind',
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '-Ctarget-cpu=x86-64', RAYON_NUM_THREADS: '4' };
  assert.deepEqual(compilerEnvironment(env), env);
});
test('unobserved cached capture and altered effective panic/debug assertions refuse', t => {
  const f = compilerFixture(t), evidence = () => compilerEvidence(f.events, f.artifacts, f.context, f.files);
  assert.deepEqual(evidence().events, f.events);
  assert.throws(() => compilerEvidence([], f.artifacts, f.context, f.files));
  f.artifacts.at(-1).fresh = true; assert.throws(evidence); f.artifacts.at(-1).fresh = false;
  f.artifacts.at(-1).profile.debug_assertions = true; assert.throws(evidence); f.artifacts.at(-1).profile.debug_assertions = false;
  f.events.at(-1).args.push('-C', 'panic=abort'); assert.throws(evidence);
});
