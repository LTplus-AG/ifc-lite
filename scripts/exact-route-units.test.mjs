/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilerEvidence } from './exact-route-compiler.mjs';
import { compareUnitPolicies } from './exact-route-units.mjs';
import { digest } from './exact-route-inputs.mjs';
import { compilerFixture } from './lib/exact-route-unit-fixture.mjs';
const compiled = f => compilerEvidence(f.events, f.artifacts, f.context, f.files);
const geometry = f => f.artifacts.findIndex(a => a.target.name === 'ifc-lite-geometry');
test('every reached critical/external/example unit has bound source/config/toolchain/output policy', t => {
  const a = compiled(compilerFixture(t)), b = compiled(compilerFixture(t));
  assert.equal(a.units.length, 5);
  assert.equal(a.units.filter(u => !u.workspace).length, 1);
  assert.doesNotThrow(() => compareUnitPolicies(a.units, b.units));
});
for (const which of ['geometry', 'processing', 'external']) {
  for (const change of ['profile', 'args', 'features']) test(`same example, differing ${which} ${change} refuses`, t => {
    const a = compilerFixture(t), b = compilerFixture(t);
    const i = which === 'geometry' ? geometry(b) : which === 'processing' ? 3 : 0;
    if (change === 'profile') { b.artifacts[i].profile.opt_level = '0'; b.events[i].args.push('-C', 'opt-level=0'); }
    if (change === 'args') b.events[i].args.push('-C', 'debug-assertions=yes');
    if (change === 'features') b.artifacts[i].features.push('different-effective-feature');
    const left = compiled(a), right = compiled(b);
    assert.deepEqual(left.policies, right.policies); assert.deepEqual(left.exampleProfile, right.exampleProfile);
    assert.throws(() => compareUnitPolicies(left.units, right.units));
  });
}
for (const [name, mutate] of Object.entries({
  cachedNoTrace: (f, i) => { f.artifacts[i].fresh = true; f.events.splice(i, 1); },
  cachedWithUnqualifiedLabel: (f, i) => { f.artifacts[i].fresh = true; f.artifacts[i].retainedTrace = { trusted: true }; },
  missingTrace: (f, i) => f.events.splice(i, 1),
  wrongOutput: (f, i) => f.events[i].outputs[f.artifacts[i].filenames[0]] = 'b'.repeat(64),
  wrongSource: (f, i) => { f.events[i].inputsBefore['src/lib.rs'] = 'b'.repeat(64); f.events[i].inputsAfter['src/lib.rs'] = 'b'.repeat(64); },
  wrongContext: (f, i) => f.events[i].contextSha256 = 'b'.repeat(64),
  configMutation: (f, i) => f.events[i].configurationAfter.global = 'b'.repeat(64),
  unboundConfig: (f, i) => { f.events[i].configurationBefore.global = 'b'.repeat(64); f.events[i].configurationAfter.global = 'b'.repeat(64); },
  wrongToolchain: (f, i) => f.events[i].version = 'other compiler',
  failedCompile: (f, i) => f.events[i].status = 1,
  missingArtifactHash: (f, i) => delete f.files[f.artifacts[i].filenames[0]],
  wrongLinkedBytes: f => { const e = f.events.at(-1); e.externInputs[Object.keys(e.externInputs)[0]] = 'b'.repeat(64); },
})) test(`dependency provenance negative: ${name}`, t => {
  const f = compilerFixture(t); mutate(f, geometry(f)); assert.throws(() => compiled(f));
});
test('missing critical crate and unpaired dependency cohort refuse', t => {
  const f = compilerFixture(t); f.artifacts.splice(geometry(f), 1); assert.throws(() => compiled(f));
  const a = compiled(compilerFixture(t)); assert.throws(() => compareUnitPolicies(a.units, a.units.slice(1)));
});
test('external same-package source changes cannot hide behind matching example policy', t => {
  const a = compilerFixture(t), b = compilerFixture(t);
  b.events[0].inputsBefore['lib.rs'] = 'b'.repeat(64); b.events[0].inputsAfter['lib.rs'] = 'b'.repeat(64);
  const left = compiled(a), right = compiled(b);
  assert.deepEqual(left.policies, right.policies); assert.throws(() => compareUnitPolicies(left.units, right.units));
});
test('context digest binds actual source and selected configuration', t => {
  const f = compilerFixture(t); f.context.configuration.external = 'c'.repeat(64);
  assert.notEqual(f.events[0].contextSha256, digest(f.context)); assert.throws(() => compiled(f));
});

test('dependency arguments beyond codegen subset remain policy-relevant', t => {
  const a = compilerFixture(t), b = compilerFixture(t);
  b.events[geometry(b)].args.push('--sysroot', '/different/sysroot');
  const left = compiled(a), right = compiled(b); assert.deepEqual(left.policies, right.policies);
  assert.throws(() => compareUnitPolicies(left.units, right.units));
});
test('package version and selected source cannot detach from Cargo artifact identity', t => {
  const f = compilerFixture(t); f.events[geometry(f)].package.version = '2.0.0'; assert.throws(() => compiled(f));
});

test('generated compiler input changes or omitted provenance refuse', t => {
  const f = compilerFixture(t); delete f.events[geometry(f)].generatedInputsBefore; assert.throws(() => compiled(f));
  const g = compilerFixture(t); g.events[geometry(g)].generatedInputsAfter = { generated: 'b'.repeat(64) };
  assert.throws(() => compiled(g));
});
