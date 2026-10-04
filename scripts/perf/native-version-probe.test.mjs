/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, fstatSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cargoArgs } from './native-hosted-plan.mjs';
import { withPinnedNativeExecutables, hashPinnedNativeExecutable, rustcReadOnlyQueryKind, versionProbeAdmission, versionProbePredicates } from './native-version-probe.mjs';

// Recorded OS-observation invariants; the separate real Cargo startup control
// must also witness the live read-only query. These do not stand in for that run.
const targetArgs = ['-', '--crate-name', '___', '--print=file-names',
  '--crate-type', 'bin', '--crate-type', 'rlib', '--crate-type', 'dylib',
  '--crate-type', 'cdylib', '--crate-type', 'staticlib', '--crate-type', 'proc-macro',
  '--print=sysroot', '--print=split-debuginfo', '--print=crate-name', '--print=cfg', '-Wwarnings'];
function ownership(queryKind = 'version') {
  const expected = { rustc: '/frozen/rustc', cargo: '/frozen/cargo', rustup: '/selected/rustup',
    directory: '/source/base', group: 20, rustcFileIdentity: { dev: '10', ino: '100' },
    cargoFileIdentity: { dev: '10', ino: '200' }, rustupFileIdentity: { dev: '10', ino: '300' },
    rustcFileBytes: 64, cargoFileBytes: 128, rustupFileBytes: 256, rustcSha256: 'a'.repeat(64), cargoSha256: 'b'.repeat(64), rustupSha256: 'c'.repeat(64) };
  const parent = { pid: 21, ppid: 20, pgrp: 20, startTime: '90', cwd: expected.directory,
    executableObserved: true, executable: expected.cargo, executableFileIdentity: expected.cargoFileIdentity,
    executableSha256: expected.cargoSha256, argv: [expected.cargo, ...cargoArgs] };
  const child = { pid: 22, ppid: 21, pgrp: 20, startTime: '99', cwd: expected.directory,
    executableObserved: true, executable: expected.rustc, executableFileIdentity: expected.rustcFileIdentity,
    executableSha256: expected.rustcSha256, argv: [expected.rustc, ...(queryKind === 'version' ? ['-vV'] : targetArgs)] };
  const identity = ({ pid, ppid, pgrp, startTime }) => ({ pid, ppid, pgrp, startTime });
  return { expected, record: structuredClone(child), proof: { captureStartedAt: 100, captureCompletedAt: 102,
    admittedParent: structuredClone(parent), parentWitness: identity(parent),
    currentParent: structuredClone(parent), currentChild: structuredClone(child),
    postOpenParent: structuredClone(parent), postOpenChild: structuredClone(child),
    pinsOpenedAt: 101, postOpenObservedAt: 101,
    pinnedParent: { fileIdentity: expected.cargoFileIdentity, bytes: expected.cargoFileBytes, sha256: expected.cargoSha256 },
    pinnedChild: { fileIdentity: expected.rustcFileIdentity, bytes: expected.rustcFileBytes, sha256: expected.rustcSha256 },
    finalParent: structuredClone(parent), finalChild: structuredClone(child),
    finalChildStat: { observed: true, before: identity(child), after: identity(child) },
    snapshot: { at: 101, members: [identity(parent), identity(child)] } } };
}
for (const queryKind of ['version', 'cargo-target-info']) {
  test(`#6537 only an exact frozen rustc read-only child of a still-admitted live Cargo can qualify (${queryKind})`, () => {
    const { expected, record, proof } = ownership(queryKind);
    assert.ok(Object.values(versionProbePredicates(record, expected, proof)).every(Boolean));
    const admitted = versionProbeAdmission(record, expected, proof);
    assert.equal(admitted.admission, 'exact-frozen-rustc-read-only-child');
    assert.equal(admitted.queryKind, queryKind);
    assert.deepEqual(admitted.argv, record.argv);
    assert.equal(admitted.ancestry.parent.pid, admitted.ppid);
    assert.equal(versionProbeAdmission(record, expected, undefined), null, 'missing fresh proof must refuse');
    for (const finalStat of [{ ...proof.finalChildStat, before: null },
      { ...proof.finalChildStat, after: { ...proof.finalChildStat.after, startTime: 'reused' } }]) {
      assert.equal(versionProbeAdmission(record, expected, { ...proof, finalChildStat: finalStat }), null,
        'a live final record requires both original PID/start stat observations');
    }
  });
}

test('#6537 compilation, alternate argv0, permission fallback and foreign compiler paths never become read-only queries', () => {
  const { expected, record, proof } = ownership();
  for (const changes of [{ argv: [expected.rustc, '-vV', '--crate-name', 'work'] },
    { argv: [expected.rustc, '-V'] }, { argv: ['rustc', '-vV'] },
    { executable: '/unknown/rustc' }, { executableObserved: false }]) {
    const altered = { ...record, ...changes };
    assert.equal(rustcReadOnlyQueryKind(altered, expected), null);
    assert.equal(versionProbeAdmission(altered, expected, proof), null);
  }
});
for (const queryKind of ['version', 'cargo-target-info']) {
  test(`#6537 child/parent PID reuse, reparenting, group/cwd/argv/executable drift and missing observations refuse (${queryKind})`, () => {
    const original = ownership(queryKind);
    const mutations = [
      p => { p.currentChild.pid++; }, p => { p.currentChild.startTime = '100'; },
      p => { p.currentChild.ppid++; }, p => { p.currentChild.pgrp++; }, p => { p.currentChild.cwd = '/foreign'; },
      p => { p.currentChild.argv.push('--emit=metadata'); }, p => { p.currentChild.executableObserved = false; },
      p => { p.currentChild = null; }, p => { p.currentParent = null; },
      p => { p.currentParent.pid++; }, p => { p.currentParent.startTime = '91'; },
      p => { p.currentParent.ppid++; }, p => { p.currentParent.pgrp++; }, p => { p.currentParent.cwd = '/foreign'; },
      p => { p.currentParent.argv.push('--locked'); }, p => { p.currentParent.executable = '/foreign/cargo'; },
      p => { p.currentParent.executableObserved = false; }, p => { p.admittedParent = null; },
      p => { p.admittedParent.startTime = '89'; }, p => { p.parentWitness = null; },
      p => { p.parentWitness.startTime = '89'; }, p => { p.finalChild = null; }, p => { p.finalParent = null; },
      p => { p.finalChild.startTime = '100'; }, p => { p.finalParent.executable = '/foreign/cargo'; },
    ];
    for (const mutate of mutations) {
      const { record, expected, proof } = structuredClone(original); mutate(proof);
      assert.equal(versionProbeAdmission(record, expected, proof), null, 'every live ownership fence is required');
    }
  });
}

for (const queryKind of ['version', 'cargo-target-info']) {
  test(`#6537 both parent and child must occur in the same fresh census with their exact identities (${queryKind})`, () => {
    for (const alter of [p => { p.snapshot.members = []; }, p => { p.snapshot.members.pop(); },
      p => { p.snapshot.members.shift(); }, p => { p.snapshot.members[0].startTime = '89'; },
      p => { p.snapshot.members[1].ppid = 23; }, p => { p.snapshot.members[1].pgrp = 19; },
      p => { p.snapshot.at = 99; }, p => { p.snapshot.at = 103; }]) {
      const { record, expected, proof } = ownership(queryKind); alter(proof);
      assert.equal(versionProbeAdmission(record, expected, proof), null);
    }
  });
}

for (const queryKind of ['version', 'cargo-target-info']) {
  test(`#6537 current compiler and Cargo hashes/file identities are mandatory even with correct paths and ancestry (${queryKind})`, () => {
    for (const alter of [p => { delete p.pinnedChild.sha256; },
      p => { p.pinnedChild.sha256 = 'f'.repeat(64); }, p => { p.currentChild.executableFileIdentity = { dev: '10', ino: '101' }; },
      p => { delete p.pinnedParent.sha256; }, p => { p.pinnedParent.sha256 = 'f'.repeat(64); },
      p => { p.currentParent.executableFileIdentity = { dev: '10', ino: '201' }; },
      p => { p.finalChild.executableFileIdentity = { dev: '10', ino: '101' }; }]) {
      const { record, expected, proof } = ownership(queryKind); alter(proof);
      assert.equal(versionProbeAdmission(record, expected, proof), null);
    }
    const { record, expected, proof } = ownership(queryKind); delete expected.rustcSha256;
    assert.equal(versionProbeAdmission(record, expected, proof), null);
  });
}

// Actual filesystem operations test the FD ownership and byte-bound contract.
const source = path => ({ path, bytes: statSync(path).size,
  fileIdentity: { dev: String(statSync(path).dev), ino: String(statSync(path).ino) } });
test('#6537 pinned executable bytes survive pathname replacement and all owned FDs close', () => {
  const directory = mkdtempSync(join(tmpdir(), 'version-pinned-proof-'));
  const original = join(directory, 'rustc'), parent = join(directory, 'cargo');
  const bytes = Buffer.from('independent exact executable content\n');
  const fds = [];
  try {
    writeFileSync(original, bytes); writeFileSync(parent, 'independent parent executable\n');
    const frozen = [source(original), source(parent)];
    const result = withPinnedNativeExecutables(frozen, pins => {
      fds.push(...pins.map(pin => pin.fd));
      unlinkSync(original); writeFileSync(original, 'replacement path content\n');
      return pins.map(hashPinnedNativeExecutable);
    });
    assert.equal(result[0].sha256, createHash('sha256').update(bytes).digest('hex'), 'read the pinned original, never the replacement pathname');
    assert.deepEqual(result[0].fileIdentity, frozen[0].fileIdentity);
    assert.notDeepEqual(source(original).fileIdentity, result[0].fileIdentity);
    for (const fd of fds) assert.throws(() => fstatSync(fd), { code: 'EBADF' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('#6537 failed second open, callback failure, copied inode and wrong regular-file size refuse without leaking FDs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'version-pinned-refusal-'));
  try {
    const original = join(directory, 'rustc'), parent = join(directory, 'cargo'), copy = join(directory, 'copy');
    writeFileSync(original, 'exact compiler content\n'); writeFileSync(parent, 'exact parent content\n'); copyFileSync(original, copy);
    const frozen = [source(original), source(parent)], before = readdirSync('/proc/self/fd').sort();
    let invoked = false;
    assert.throws(() => withPinnedNativeExecutables([frozen[0], { ...frozen[1], path: join(directory, 'missing') }], () => { invoked = true; }));
    assert.equal(invoked, false, 'a missing second executable cannot reach live-binding capture');
    assert.deepEqual(readdirSync('/proc/self/fd').sort(), before, 'first FD is closed when second open fails');
    for (const first of [{ ...frozen[0], path: copy }, { ...frozen[0], bytes: frozen[0].bytes + 1 },
      { ...frozen[0], path: directory }]) {
      let invalidCaptured = false;
      assert.throws(() => withPinnedNativeExecutables([first, frozen[1]], () => { invalidCaptured = true; }));
      assert.equal(invalidCaptured, false, 'invalid frozen file cannot reach capture');
      assert.deepEqual(readdirSync('/proc/self/fd').sort(), before);
    }
    const held = [];
    assert.throws(() => withPinnedNativeExecutables(frozen, pins => {
      held.push(...pins.map(pin => pin.fd)); throw new Error('independent capture refusal');
    }));
    for (const fd of held) assert.throws(() => fstatSync(fd), { code: 'EBADF' });
    assert.throws(() => withPinnedNativeExecutables(frozen, pins => {
      writeFileSync(original, 'actual changed longer compiler bytes\n'); return hashPinnedNativeExecutable(pins[0]);
    }), 'growth beyond actual frozen executable size refuses');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
for (const queryKind of ['version', 'cargo-target-info']) {
  test(`#6537 only explicit final PID absence after post-open live binding can admit an exited query (${queryKind})`, () => {
    const { record, expected, proof } = ownership(queryKind);
    proof.finalChild = null; proof.finalChildStat = { observed: true, before: null, after: null };
    assert.equal(versionProbeAdmission(record, expected, proof)?.childDisposition, 'exited-after-pinned-observation');
    for (const alter of [p => { delete p.finalChildStat; }, p => { delete p.finalChildStat.after; },
      p => { p.finalChildStat.observed = false; }, p => { p.finalChildStat.before = { ...record, startTime: 'reused' }; },
      p => { p.finalChildStat.after = { ...record, startTime: 'reused' }; },
      p => { p.finalChildStat.after = { ...record, state: 'Z' }; }, p => { p.finalParent = null; },
      p => { p.finalParent.ppid++; }, p => { p.postOpenChild = null; }, p => { p.postOpenParent = null; },
      p => { p.postOpenChild.argv.push('--emit=metadata'); }, p => { p.postOpenChild.startTime = 'reused'; },
      p => { p.postOpenChild.ppid++; }, p => { p.postOpenParent.cwd = '/foreign'; },
      p => { p.postOpenParent.argv.push('--locked'); }, p => { p.postOpenParent.executableObserved = false; },
      p => { p.pinsOpenedAt = 99; }, p => { p.postOpenObservedAt = 103; },
      p => { p.pinnedChild.bytes++; }, p => { p.pinnedParent.bytes++; },
      p => { p.pinnedChild.fileIdentity = { dev: '10', ino: '101' }; },
      p => { p.pinnedParent.sha256 = 'f'.repeat(64); }]) {
      const altered = structuredClone(proof); alter(altered);
      assert.equal(versionProbeAdmission(record, expected, altered), null, 'absence does not bypass contemporaneous provenance or live parent');
    }
  });
}


test('#6537 target-information queries reject every argument alteration and source/output/emit option', () => {
  const { expected, record, proof } = ownership('cargo-target-info');
  const invalid = [
    [...targetArgs, '--emit=link'], [...targetArgs, '--print=link-args'],
    targetArgs.map(arg => arg === '--print=file-names' ? '--print=file-names=/tmp/output' : arg),
    targetArgs.map(arg => arg === '-' ? 'source.rs' : arg),
    targetArgs.map(arg => arg === '___' ? 'foreign' : arg),
    targetArgs.map(arg => arg === '-Wwarnings' ? '-Awarnings' : arg),
    targetArgs.filter(arg => arg !== '--print=cfg'),
    [...targetArgs.slice(0, -2), ...targetArgs.slice(-2).reverse()],
    [...targetArgs, '-C', 'opt-level=3'], [...targetArgs, '--out-dir', '/tmp/output'],
  ];
  for (const suffix of invalid) {
    const altered = { ...record, argv: [expected.rustc, ...suffix] };
    assert.equal(rustcReadOnlyQueryKind(altered, expected), null);
    assert.equal(versionProbeAdmission(altered, expected, proof), null);
  }
  for (const field of ['currentChild', 'postOpenChild', 'finalChild']) {
    const changed = structuredClone(proof);
    changed[field].argv = [expected.rustc, '-vV'];
    assert.equal(versionProbeAdmission(record, expected, changed), null,
      'changing between individually valid query kinds is not process continuity');
  }
});

test('#6537 target-query initial identity, observation chronology and Cargo ownership cannot be substituted', () => {
  for (const mutate of [
    ({ record }) => { record.executableFileIdentity.ino = 'foreign'; },
    ({ record }) => { record.cwd = '/foreign'; },
    ({ record }) => { record.pgrp++; },
    ({ record }) => { record.executableObserved = false; },
    ({ record }) => { record.argv[0] = 'rustc'; },
    ({ proof }) => { proof.captureStartedAt = 102; },
    ({ proof }) => { proof.captureCompletedAt = 100; },
    ({ proof }) => { proof.postOpenObservedAt = 103; },
    ({ proof }) => { proof.snapshot.at = 103; },
    ({ proof }) => { proof.admittedParent.argv.push('--release'); },
    // Cached witness binds PID/start; group comes from live parent and fresh census.
    ({ proof }) => { proof.parentWitness.pid++; },
    ({ proof }) => { proof.currentParent.argv = ['cargo', ...cargoArgs, '--emit=metadata']; },
  ]) {
    const fixture = ownership('cargo-target-info'); mutate(fixture);
    assert.equal(versionProbeAdmission(fixture.record, fixture.expected, fixture.proof), null,
      'target discovery does not waive initial compiler, chronology or admitted-parent binding');
  }
});
