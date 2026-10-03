/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, linkSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeFileIdentity, sameNativeFile } from './native-file-identity.mjs';
import { schedule, revisions, validateRefs, probeResult, freshnessLog, freshnessException, freshnessPredicates, cargoArgs, requirePair, phases, requireCompletion, refreshedCargoWitness } from './native-hosted-plan.mjs';
function result() {
  return { ...Object.fromEntries(phases.map(key => [key, 1])), fileMb: 2.4, entities: 100, meshes: 5, vertices: 30, triangles: 10,
    pointCacheHits: 0, pointCacheMisses: 0, csgFailures: 0, degenerateDropped: 0, path: '/fixture.ifc',
    allTotalsMs: [1, 2, 3, 4, 5], allWallMs: [2, 3, 4, 5, 6], meshFingerprintsFnv1a64: Array(5).fill('abcdef0123456789') };
}
test('#6537 native fixed schedule has two Haus AA and five alternating AB per family, no substitutes', () => {
  const rows = schedule(); assert.equal(rows.length, 17); assert.equal(rows.flatMap(row => row.order).length, 34);
  assert.deepEqual(rows.slice(0, 2).map(row => [row.family, row.kind, row.order]), Array(2).fill(['house', 'AA', ['base', 'base']]));
  for (const family of ['house', 'csg', 'heavy-csg']) {
    const pairs = rows.filter(row => row.family === family && row.kind === 'AB'); assert.equal(pairs.length, 5);
    assert.deepEqual(pairs.map(row => row.order[0]), ['base', 'candidate', 'base', 'candidate', 'base']);
  }
  validateRefs(revisions.base, revisions.candidate);
  assert.throws(() => validateRefs(revisions.candidate, revisions.base)); assert.throws(() => validateRefs('main', revisions.candidate));
});
test('#6537 native probe refuses unknown/missing/nonfinite numeric data, wrong iteration count, changed FNV and wrong best-total', () => {
  const row = result(); assert.equal(probeResult(JSON.stringify([row]), row.path).meshes, 5);
  for (const alter of [r => { delete r.geometryMs; }, r => { r.geometryMs = null; }, r => { r.extra = 1; },
    r => { r.entities = 1.5; }, r => { r.allWallMs.pop(); }, r => { r.allTotalsMs[4] = 0; },
    r => { r.meshFingerprintsFnv1a64[4] = '1234567890abcdef'; }, r => { r.totalMs = 2; }]) {
    const broken = structuredClone(row); alter(broken); assert.throws(() => probeResult(JSON.stringify([broken]), row.path));
  }
  assert.throws(() => probeResult(JSON.stringify([row, row]), row.path)); assert.throws(() => probeResult(JSON.stringify([row]), '/other.ifc'));
});
test('#6537 no-op Cargo receipt distinguishes actual compilation and missing/duplicate freshness from a successful exit', () => {
  const finished = '    Finished `profiling` profile [optimized + debuginfo] target(s) in 0.11s\n';
  freshnessLog(finished);
  for (const raw of ['', finished + finished, 'Compiling ifc-lite-processing v1.0\n' + finished,
    'Checking ifc-lite-geometry\n' + finished, 'warning: reused output\n' + finished, 'worker recovery\n' + finished]) assert.throws(() => freshnessLog(raw));
});
test('#6537 Cargo exception requires own PID/start fence, exact args, executable, process group and source cwd', () => {
  const expected = { group: 20, directory: '/arm', cargo: '/tool/cargo', rustup: '/tool/rustup' };
  const record = { pid: 21, startTime: '99', pgrp: 20, cwd: '/arm', executableObserved: true, executable: '/tool/cargo', argv: ['cargo', ...cargoArgs] };
  assert.equal(freshnessException(record, record, expected), true);
  for (const changes of [{ executableObserved: false }, { startTime: '100' }, { pgrp: 19 }, { cwd: '/foreign' }, { executable: '/tool/rustc' },
    { argv: ['cargo', 'test'] }, { argv: ['cargo', ...cargoArgs, '--features', 'observability'] }]) {
    assert.equal(freshnessException({ ...record, ...changes }, record, expected), false);
  }
  assert.equal(freshnessException(record, undefined, expected), false);
  assert.equal(freshnessPredicates({ ...record, argv: ['cargo', 'test'] }, record, expected).exactBuildArgs, false);
  assert.equal(freshnessPredicates({ ...record, startTime: '100' }, record, expected).sameStartTime, false);
  assert.equal(freshnessPredicates({ ...record, cwd: '/foreign' }, record, expected).sourceCwd, false);
  assert.equal(freshnessPredicates({ ...record, executableObserved: false }, record, expected).executableObserved, false);
});
test('#6537 native paired controls use all-five medians, reject census/FNV drift and retain AA noise refusal', () => {
  const left = result(), right = structuredClone(left);
  right.allWallMs = [6, 2, 5, 3, 4]; assert.deepEqual(requirePair(left, right, 'AA').wallMediansMs, [4, 4]);
  right.allWallMs = [4, 6, 8, 10, 12]; assert.throws(() => requirePair(left, right, 'AA'), /noise/);
  requirePair(left, right, 'AB'); right.csgFailures = 1; assert.throws(() => requirePair(left, right, 'AB'), /counts/);
  right.csgFailures = 0; right.meshFingerprintsFnv1a64.fill('1234567890abcdef'); assert.throws(() => requirePair(left, right, 'AB'), /FNV/);
});
test('#6537 final cancellation or failed frozen verification cannot become a completed finite cohort', () => {
  const pairs = schedule().map(row => ({ ...row, status: 'complete' }));
  requireCompletion(undefined, pairs, 'complete');
  assert.throws(() => requireCompletion('received SIGTERM during final verification', pairs, 'complete'), /SIGTERM/);
  assert.throws(() => requireCompletion(undefined, pairs, 'refused'));
  assert.throws(() => requireCompletion(undefined, pairs.slice(1), 'complete'));
  pairs[16].status = 'refused'; assert.throws(() => requireCompletion(undefined, pairs, 'complete'));
});
test('#6537 refreshed Cargo witness still requires actual executable, fresh own ancestry and matching current PID/start/group', () => {
  const expected = { group: 20, directory: '/arm', cargo: '/tool/cargo', rustup: '/tool/rustup' };
  const record = { pid: 21, startTime: '99', pgrp: 20, cwd: '/arm', executableObserved: true, executable: '/tool/cargo', argv: ['cargo', ...cargoArgs] };
  const member = { pid: 21, startTime: '99', pgrp: 20 }, snapshot = { members: [member] };
  assert.deepEqual(refreshedCargoWitness(record, expected, snapshot, record), member);
  for (const members of [[], [{ ...member, pid: 22 }], [{ ...member, startTime: '100' }], [{ ...member, pgrp: 19 }]]) {
    assert.equal(refreshedCargoWitness(record, expected, { members }, record), null);
  }
  for (const changes of [{ pid: 22 }, { startTime: '100' }, { pgrp: 19 }, { cwd: '/foreign' },
    { executable: '/tool/rustc' }, { executableObserved: false }, { argv: ['cargo', 'test'] }]) {
    assert.equal(refreshedCargoWitness(record, expected, snapshot, { ...record, ...changes }), null);
  }
  assert.equal(refreshedCargoWitness({ ...record, executableObserved: false }, expected, snapshot, record), null);
});
test('#6537 real executable hardlink identity admits aliases but rejects copies and every missing ownership fence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-file-identity-'));
  try {
    const frozen = join(directory, 'rustup'), alias = join(directory, 'different-name'), copy = join(directory, 'same-bytes-copy');
    writeFileSync(frozen, 'executable identity control\n'); linkSync(frozen, alias); copyFileSync(frozen, copy);
    const expected = { group: 20, directory, cargo: '/tool/cargo', rustup: frozen, rustupFileIdentity: nativeFileIdentity(frozen) };
    const record = { pid: 21, startTime: '99', pgrp: 20, cwd: directory, executableObserved: true,
      executable: alias, executableFileIdentity: nativeFileIdentity(alias), argv: ['cargo', ...cargoArgs] };
    assert.ok(sameNativeFile(record.executableFileIdentity, expected.rustupFileIdentity), 'a real hardlink identifies the same file');
    assert.equal(freshnessException(record, record, expected), true);
    assert.equal(sameNativeFile(nativeFileIdentity(copy), expected.rustupFileIdentity), false, 'copying identical bytes creates a distinct file');
    for (const changes of [{ executable: copy, executableFileIdentity: nativeFileIdentity(copy) },
      { executableFileIdentity: undefined }, { executableFileIdentity: {} },
      { executableFileIdentity: { ...record.executableFileIdentity, dev: '999999999' } },
      { pid: 22 }, { startTime: '100' }, { pgrp: 19 }, { cwd: '/foreign' },
      { argv: ['cargo', 'test'] }, { argv: ['rustup', ...cargoArgs] }, { executableObserved: false }]) {
      assert.equal(freshnessException({ ...record, ...changes }, record, expected), false);
    }
    assert.equal(freshnessException(record, undefined, expected), false);
    assert.equal(freshnessException(record, record, { ...expected, rustupFileIdentity: undefined }), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
