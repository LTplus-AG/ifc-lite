/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './exact-route-source.mjs';
import { cohort } from './lib/exact-route-cohort.mjs';

// Source mutations rebind the synthetic fleet output-log binding deliberately: an
// internally consistent label/hash still cannot substitute for independent Git.
test('complete Git-bound clean-fleet cohort compares', t => assert.equal(cohort(t).compare().equal, true));
for (const [name, mutate] of Object.entries({
  missingFixture: r => r.fixtures.pop(), wrongSource: r => r.source = 'b'.repeat(40),
  wrongTree: r => r.sourceTree = 'b'.repeat(40), wrongExecutionTree: r => r.executionTree = 'b'.repeat(40),
  emptyHashes: r => r.trackedSourceHashes = {},
  changedHash: r => r.trackedSourceHashes['Cargo.lock'] = 'b'.repeat(64),
  missingHash: r => delete r.trackedSourceHashes['Cargo.lock'],
  extraHash: r => r.trackedSourceHashes['not-in-tree'] = 'b'.repeat(64),
  sourceOverlay: r => r.harness = {}, failedBuild: r => r.status = 'FAILED',
  toolchain: r => r.toolchain = 'different', options: r => r.options = 'different',
  fixtureBytes: r => r.fixtures[0].sha256 = 'b'.repeat(64), captureBytes: r => r.fixtures[0].captureSha256 = 'b'.repeat(64),
  flags: r => r.environment.RUSTFLAGS = '-C opt-level=0',
  hiddenProfileOverride: r => r.environment.CARGO_PROFILE_SERVER_RELEASE_PANIC = 'abort',
  compilerArgs: r => r.compiler.events[0].args.push('-C', 'debug-assertions=yes'),
  compilerLogPin: r => r.compiler.invocationSha256 = 'b'.repeat(64),
  binaryHash: r => r.binary.sha256 = 'b'.repeat(64),
})) test(`independent receipt mutation refuses: ${name}`, t => {
  const c = cohort(t); c.alter(mutate); assert.throws(c.compare);
});
for (const [name, mutate] of Object.entries({
  missingBefore: f => delete f.sourceBefore,
  dirty: f => { f.sourceBefore.clean = false; f.sourceAfter.clean = false; },
  changed: f => f.sourceUnchanged = false, nonterminal: f => f.state = 'running',
  failure: f => f.exitCode = 1,
  pairedWrongTree: f => { f.sourceBefore.tree = 'b'.repeat(40); f.sourceAfter.tree = 'b'.repeat(40); },
  beforeAfterMismatch: f => f.sourceAfter.commit = 'b'.repeat(40),
  toolchainBlob: f => { f.sourceBefore.toolchainInputs['Cargo.lock'] = 'b'.repeat(64); f.sourceAfter.toolchainInputs['Cargo.lock'] = 'b'.repeat(64); },
  unboundOutput: f => f.outputSha256 = 'b'.repeat(64), command: f => f.command = ['true'],
})) test(`external fleet mutation refuses: ${name}`, t => {
  const c = cohort(t); c.fleet(mutate); assert.throws(c.compare);
});
test('real Git execution commit with a non-overlay source edit refuses', t => {
  const c = cohort(t); writeFileSync(join(c.repo, 'Cargo.lock'), 'changed source'); c.git(['add', '.']);
  const changed = c.commit('foreign source edit'); c.alter(r => r.executionCommit = changed); assert.throws(c.compare);
});
for (const [name, mutate] of Object.entries({
  options: v => v.options = 'identical alternate options',
  skeletal: v => v.scene.meshes = [{}],
  metadata: v => v.scene.metadata = {},
  truncatedNormals: v => v.scene.meshes[0].serialized.normals.pop(),
})) test(`paired identical payload mutation with rebound hashes refuses: ${name}`, t => {
  const c = cohort(t); c.capture(mutate, 0); c.capture(mutate, 1); assert.throws(c.compare);
});

for (const count of [0, 2]) test(`independent output log requires exactly one receipt marker: ${count}`, t => {
  const c = cohort(t); writeFileSync(c.fleetLogs[1], 'EXACT_ROUTE_RECEIPT_SHA256 invalid\n'.repeat(count));
  c.fleet(f => f.outputSha256 = sha256('EXACT_ROUTE_RECEIPT_SHA256 invalid\n'.repeat(count)));
  assert.throws(c.compare);
});

for (const which of ['geometry', 'processing', 'external']) {
  test(`identical scenes/example, internally rebound ${which} policy still refuses`, t => {
    const c = cohort(t);
    c.compiler(({ events, artifacts }) => {
      const i = which === 'geometry' ? 2 : which === 'processing' ? 3 : 0;
      artifacts[i].profile.opt_level = '0'; events[i].args.push('-C', 'opt-level=0');
    });
    assert.throws(c.compare, /dependency effective/);
  });
}

test('identical scenes/example, internally rebound dependency arguments refuse', t => {
  const c = cohort(t);
  c.compiler(({ events }) => events[2].args.push('--sysroot', '/different/dependency-sysroot'));
  assert.deepEqual(readFileSync(join(c.dirs[0], '0.json')), readFileSync(join(c.dirs[1], '0.json')));
  assert.throws(c.compare, /dependency effective policy/);
});
test('identical scenes/example, cached dependency without qualified trace refuses', t => {
  const c = cohort(t), path = join(c.dirs[1], 'cargo-artifacts.jsonl');
  const artifacts = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(v => JSON.parse(v));
  artifacts[2].fresh = true; artifacts[2].retainedTrace = { trusted: true };
  writeFileSync(path, artifacts.map(v => JSON.stringify(v)).join('\n'));
  c.alter(r => r.compiler.artifactEventsSha256 = sha256(readFileSync(path)));
  assert.deepEqual(readFileSync(join(c.dirs[0], '0.json')), readFileSync(join(c.dirs[1], '0.json')));
  assert.throws(c.compare, /cached artifact has no qualified retained compile trace/);
});
