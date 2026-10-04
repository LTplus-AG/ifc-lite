/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import { INPUT_PROTOCOL, INPUT_SUBJECTS, inputProtocol, qualifyInputSubjects, requireInputProof,
  registerInputWitness, captureInputWitness, disposeInputWitness, requireInputAppearancePair } from './input-witness-integration.mjs';
import { inputWitnessFixture } from './input-witness-fixture.mjs';

const contractBytes = readFileSync(new URL('./input-witness-source-contract.json', import.meta.url));
const contract = JSON.parse(contractBytes);
const proof = { protocol: INPUT_PROTOCOL, subjects: INPUT_SUBJECTS, immutableArguments: true,
  manifestSha256: createHash('sha256').update(contractBytes).digest('hex'), sourceFiles: contract.sourceContract.length };

test('#6537 input protocol requires explicit opt-in and refuses unknown mode', () => {
  assert.equal(inputProtocol(undefined), null); assert.equal(inputProtocol('false'), null);
  assert.equal(inputProtocol('true'), INPUT_PROTOCOL);
  for (const mode of ['', true, 'TRUE', 'legacy']) assert.throws(() => inputProtocol(mode), /unknown/);
});

test('#6537 source producer verifies actual pinned file bytes and rejects a changed path before admission', async t => {
  const required = process.env.INPUT_WITNESS_FIXTURES_REQUIRED === 'true';
  const subjectDirs = { base: process.env.BASE_DIR, candidate: process.env.CANDIDATE_DIR };
  const readers = {};
  for (const arm of ['base', 'candidate']) {
    const sourceDir = subjectDirs[arm];
    if (sourceDir) {
      const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8', timeout: 5000 }).trim();
      assert.equal(actual, INPUT_SUBJECTS[arm], `checked-out ${arm} must be the literal subject`);
      readers[arm] = path => readFileSync(join(sourceDir, path));
    } else {
      if (required) throw new Error(`Required dedicated-workflow ${arm} checkout is unavailable`);
      try {
        execFileSync('git', ['cat-file', '-e', `${INPUT_SUBJECTS[arm]}^{commit}`],
          { cwd: new URL('../..', import.meta.url), timeout: 5000, stdio: 'pipe' });
      } catch (error) {
        t.skip(`Fixed subject compatibility fixture absent; run the dedicated independent-input workflow with BASE_DIR/CANDIDATE_DIR and INPUT_WITNESS_FIXTURES_REQUIRED=true (${error.message})`);
        return;
      }
      readers[arm] = path => execFileSync('git', ['show', `${INPUT_SUBJECTS[arm]}:${path}`],
        { cwd: new URL('../..', import.meta.url), timeout: 5000 });
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'ifc-input-contract-'));
  try {
    const builds = {};
    for (const arm of ['base', 'candidate']) {
      const dir = join(root, arm), sourceInputs = {};
      for (const row of contract.sourceContract) {
        // Opaque compatibility bytes from the verified hosted arm checkout,
        // or available local Git blobs. No fetching or source-text assertion.
        const bytes = readers[arm](row.path);
        mkdirSync(dirname(join(dir, row.path)), { recursive: true });
        writeFileSync(join(dir, row.path), bytes);
        sourceInputs[row.path] = createHash('sha256').update(bytes).digest('hex');
      }
      for (const dependency of contract.dependencies) {
        mkdirSync(dirname(join(dir, dependency.path)), { recursive: true });
        writeFileSync(join(dir, dependency.path), subjectDirs[arm]
          ? readFileSync(join(subjectDirs[arm], dependency.path))
          : readFileSync(new URL(`../../${dependency.path}`, import.meta.url)));
      }
      builds[arm] = { dir, revision: INPUT_SUBJECTS[arm], sourceInputs };
    }
    const actual = await qualifyInputSubjects(builds);
    assert.deepEqual(requireInputProof(actual, 'candidate', INPUT_SUBJECTS.candidate), {
      subjectHead: INPUT_SUBJECTS.candidate, manifestSha256: proof.manifestSha256, immutableArguments: true,
    });
    const path = contract.sourceContract[0].path;
    writeFileSync(join(builds.candidate.dir, path), new Uint8Array([0]));
    await assert.rejects(qualifyInputSubjects(builds), /unaudited independent input source/);
    builds.base.revision = INPUT_SUBJECTS.candidate;
    await assert.rejects(qualifyInputSubjects(builds), /subject mismatch/);
  } finally { rmSync(root, { recursive: true }); }
});

test('#6537 reference proof rejects wrong role, subject and contract without trusting declaration alone', () => {
  assert.equal(requireInputProof(proof, 'base', INPUT_SUBJECTS.base).subjectHead, INPUT_SUBJECTS.base);
  assert.throws(() => requireInputProof(proof, 'base', INPUT_SUBJECTS.candidate), /not bound/);
  assert.throws(() => requireInputProof({ ...proof, manifestSha256: '0'.repeat(64) }, 'base', INPUT_SUBJECTS.base), /not bound/);
  assert.throws(() => requireInputProof(proof, 'unknown', INPUT_SUBJECTS.base), /not bound/);
});

test('#6537 serialized controller installs before producer delivery, captures actual native arguments then restores wrappers', async () => {
  const context = createContext({ crypto: webcrypto, TextEncoder });
  const fixture = runInContext(`(${inputWitnessFixture.toString()})()`, context);
  const original = fixture.scene.addInstancedShard;
  const page = { evaluate(callback, argument) {
    context.argument = argument;
    return runInContext(`(${callback.toString()})(argument)`, context);
  } };
  try {
    await registerInputWitness(page, proof, 'base', INPUT_SUBJECTS.base);
    assert.equal(fixture.listeners.size, 1);
    fixture.begin(); fixture.deliver(fixture.makeShard([42, 43]));
    const identity = await captureInputWitness(page, { oneBufferBytes: 1024 ** 2,
      digestBytes: 16 * 1024 ** 2, records: 100000 });
    assert.equal(identity.occurrences, 2); assert.equal(identity.owners, 3);
    assert.equal(identity.protocol, INPUT_PROTOCOL);
    assert.equal((await disposeInputWitness(page)).restored, true);
    assert.strictEqual(fixture.scene.addInstancedShard, original); assert.equal(fixture.listeners.size, 0);
  } finally { runInContext('globalThis.__ifc_lite_input_witness__?.dispose()', context); }
});

test('#6537 serialized controller refuses genuinely dropped retained piece and still restores owned wrappers', async () => {
  const context = createContext({ crypto: webcrypto, TextEncoder });
  const fixture = runInContext(`(${inputWitnessFixture.toString()})()`, context);
  const original = fixture.scene.addInstancedShard;
  const page = { evaluate(callback, argument) {
    context.argument = argument;
    return runInContext(`(${callback.toString()})(argument)`, context);
  } };
  try {
    await registerInputWitness(page, proof, 'candidate', INPUT_SUBJECTS.candidate);
    fixture.begin(); fixture.scene.meshDataMap.clear();
    await assert.rejects(captureInputWitness(page, { oneBufferBytes: 1024 ** 2,
      digestBytes: 16 * 1024 ** 2, records: 100000 }), /flat piece multiset mismatch/);
    await disposeInputWitness(page);
    assert.strictEqual(fixture.scene.addInstancedShard, original); assert.equal(fixture.listeners.size, 0);
  } finally { runInContext('globalThis.__ifc_lite_input_witness__?.dispose()', context); }
});

test('#6537 actual pair admission rejects changed produced/input channels and unclosed observer', () => {
  const make = arm => ({ arm, revision: INPUT_SUBJECTS[arm], inputProtocol: INPUT_PROTOCOL,
    inputProof: proof, inputWitnessCleanup: { restored: true }, fullAppearanceIdentity: {
      status: 'observed', value: { protocol: INPUT_PROTOCOL, complete: true,
        producedSha256: 'a'.repeat(64), viewportInputSha256: 'b'.repeat(64), rawInstancedInputSha256: 'c'.repeat(64) } } });
  const base = make('base'), candidate = make('candidate');
  assert.equal(requireInputAppearancePair([base, candidate]).viewportInputIdentityEqual, true);
  for (const field of ['producedSha256', 'viewportInputSha256']) {
    const changed = make('candidate'); changed.fullAppearanceIdentity.value[field] = 'd'.repeat(64);
    assert.throws(() => requireInputAppearancePair([base, changed]), /mismatch/);
  }
  const unclosed = make('candidate'); unclosed.inputWitnessCleanup.restored = false;
  assert.throws(() => requireInputAppearancePair([base, unclosed]), /cleanup incomplete/);
  assert.throws(() => requireInputAppearancePair([base]), /exactly two ordered/);
});
