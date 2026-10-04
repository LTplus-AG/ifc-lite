/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidateTargetQueryCache, ownedQueryFileCensus } from './native-query-cache.mjs';

// #6537 CacheData/Output schema is pinned Cargo's compatibility contract.
// Output contents model independently observed compiler results, not helper returns.
const target = { status: 0, signal: null, stdout: '___\nlib___.rlib\n/frozen/sysroot\n___\ntarget_arch="x86_64"\n', stderr: '' };
const version = { status: 0, signal: null, stdout: 'rustc 1.93.0-nightly\nbinary: rustc\ncommit-hash: pinned\n', stderr: '' };
const record = actual => ({ success: true, status: '', code: 0, stdout: actual.stdout, stderr: actual.stderr });
const member = (key, actual) => `${JSON.stringify(key)} : ${JSON.stringify(record(actual))}`;
const other = member('7', { stdout: 'independent other query café🙂\n', stderr: '' });
function cache(members) {
  return Buffer.from(`{ "rustc_fingerprint" : 18446744073709551615,\n "outputs": {\n ${members.join(',\n ')}\n },\n "successes" : { "18446744073709551614":true, "0":false } }\n`);
}
test('#6537 selective cache removal preserves opaque u64 and every byte outside first/middle/last target span', () => {
  const v = member('18446744073709551613', version), t = member('18446744073709551612', target);
  for (const members of [[t, other, v], [other, t, v], [other, v, t]]) {
    const before = cache(members), selected = invalidateTargetQueryCache(before, target, version);
    const { removedStartByte: start, removedEndByte: end } = selected.receipt;
    assert.deepEqual(selected.after.subarray(0, start), before.subarray(0, start));
    assert.deepEqual(selected.after.subarray(start), before.subarray(end), 'all bytes outside target member/separator survive');
    assert.equal(selected.receipt.fingerprintLiteral, '18446744073709551615', 'u64 never rounds through JS Number');
    assert.equal(selected.receipt.versionKey, '18446744073709551613');
    assert.equal(selected.receipt.targetKey, '18446744073709551612');
    const outputs = JSON.parse(selected.after).outputs;
    assert.deepEqual(Object.keys(outputs).sort(), ['7', '18446744073709551613'].sort());
    assert.deepEqual(outputs['18446744073709551613'], record(version));
    assert.deepEqual(outputs['7'].stdout, 'independent other query café🙂\n');
    assert.ok(selected.after.toString().includes('"18446744073709551614":true, "0":false'), 'successes raw bytes survive');
  }
});
test('#6537 missing/ambiguous complete target or version results and target-version collisions refuse', () => {
  const v = member('2', version), t = member('3', target);
  for (const members of [[v], [t], [v, t, member('4', target)], [v, t, member('4', version)], [t, other]]) {
    assert.throws(() => invalidateTargetQueryCache(cache(members), target, version));
  }
  assert.throws(() => invalidateTargetQueryCache(cache([v, t]), target, target));
  for (const actual of [{ ...target, status: 1 }, { ...target, signal: 'SIGKILL' },
    { ...target, error: 'spawn failed' }, { ...target, stdout: target.stdout + 'changed' },
    { ...target, stderr: 'changed' }, { ...target, stdout: 'x'.repeat(131073) }]) {
    assert.throws(() => invalidateTargetQueryCache(cache([v, t]), actual, version));
  }
});
test('#6537 duplicate keys at every schema level, unknown fields, malformed scalars and numeric-key aliases refuse', () => {
  const original = cache([member('2', version), member('3', target)]).toString();
  const invalid = [
    original.replace('"outputs":', '"rustc_fingerprint":0, "outputs":'),
    original.replace('"outputs": {', '"outputs": { "2":null,'),
    original.replace('"success":true', '"success":true,"success":false'),
    original.replace('"success":true', '"success":true,"succe\\u0073s":false'),
    original.replace('"successes" : {', '"successes" : { "0":true,'),
    original.replace('"successes" :', '"unknown":null,"successes" :'),
    original.replace('"code":0', '"code":2147483648'),
    original.replace('"code":0', '"code":0.5'),
    original.replace('"2" :', '"02" :'),
    original.replace('18446744073709551615', '18446744073709551616'),
    original.replace('18446744073709551615', '1e3'),
    original.replace('"status":""', '"status":null'),
    original.replace('"0":false', '"0":false,'), original + ' trailing',
  ];
  for (const raw of invalid) assert.throws(() => invalidateTargetQueryCache(Buffer.from(raw), target, version));
});
test('#6537 cache input byte/depth/work and per-output bounds refuse before mutation', () => {
  const original = cache([member('2', version), member('3', target)]);
  assert.throws(() => invalidateTargetQueryCache(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]), target, version), /UTF8 BOM/);
  for (const raw of [Buffer.alloc(2097153, 0x20), Buffer.from([0xc3, 0x28]),
    Buffer.from('['.repeat(18) + '0' + ']'.repeat(18)),
    Buffer.from('[' + Array.from({ length: 8193 }, () => '0').join(',') + ']'),
    cache(Array.from({ length: 257 }, (_, i) => member(String(i), target))),
    Buffer.from(original.toString().replace('___\\nlib___.rlib', 'x'.repeat(131073)))]) {
    const untouched = Buffer.from(raw);
    assert.throws(() => invalidateTargetQueryCache(raw, target, version));
    assert.deepEqual(raw, untouched, 'refusal never mutates the actual supplied bytes');
  }
});
test('#6537 owned direct-query census detects real emitted files and byte changes while preserving unchanged file identity', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'owned-query-files-')));
  try {
    mkdirSync(join(directory, 'nested')); writeFileSync(join(directory, 'nested/input'), 'abc');
    const before = ownedQueryFileCensus(directory);
    assert.equal(before.entries.find(entry => entry.path === 'nested/input').sha256,
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.deepEqual(ownedQueryFileCensus(directory), before);
    writeFileSync(join(directory, 'emitted.rmeta'), 'new compiler output');
    assert.notDeepEqual(ownedQueryFileCensus(directory), before, 'an actual emitted regular file changes the witness');
    rmSync(join(directory, 'emitted.rmeta'));
    writeFileSync(join(directory, 'nested/input'), 'abd');
    assert.notDeepEqual(ownedQueryFileCensus(directory), before, 'same-length mutation changes the byte witness');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('#6537 owned file census refuses symlink escape and file resource bounds', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'owned-query-refusal-')));
  try {
    const file = join(directory, 'large'); writeFileSync(file, 'x');
    symlinkSync('/bin/sh', join(directory, 'escape'));
    assert.throws(() => ownedQueryFileCensus(directory), /symlink/);
    rmSync(join(directory, 'escape'));
    truncateSync(file, 33554433);
    assert.throws(() => ownedQueryFileCensus(directory), /file bound/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
