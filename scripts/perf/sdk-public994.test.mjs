/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { public994, fixtures, clientFixtures } from './sdk-client/contracts.ts';
import { fixtureSet, protocol, schedule } from './sdk-plan.mjs';
import { requireCohortCompletion } from './sdk-completion.mjs';
import { downloadPinnedFixture, requirePublic994Receipt } from './sdk-public994.mjs';

test('#6537 public994 is an exact immutable public-file pin separate from the original four fixtures', () => {
  assert.deepEqual(Object.keys(fixtures), ['house', 'csg', 'heavy-csg', 'architecture']);
  assert.deepEqual(public994, { path: 'public994.ifc', bytes: 189918, timeoutMs: 180000,
    sha256: '1d1cd11c57d80fe4f769a05db49cf1a96973b1af6cbee2d75ef541cfa3cb8fa0',
    sourceCommit: '9fc2267d7f1ff35284c5b0fc28cc97bff7ace8e7',
    url: 'https://raw.githubusercontent.com/IfcOpenShell/files/9fc2267d7f1ff35284c5b0fc28cc97bff7ace8e7/994--slab--segfault--augmented.ifc' });
  assert.deepEqual(clientFixtures.public994, public994);
  assert.deepEqual(fixtureSet('public994'), { public994 });
});
test('#6537 selectors declare separate exact schedules and refuse unknown or empty selectors', () => {
  assert.deepEqual(schedule(), schedule('public4')); assert.equal(schedule().length, 56);
  const plan = schedule('public994'); assert.equal(plan.length, 14); assert.equal(new Set(plan.map(row => row.id)).size, 14);
  assert.ok(plan.every(row => row.family === 'public994' && row.bytes === public994.bytes && row.sha256 === public994.sha256));
  assert.deepEqual(plan.map(row => row.arm), ['base', 'base', 'base', 'base', 'base', 'candidate', 'candidate', 'base', 'base', 'candidate', 'candidate', 'base', 'base', 'candidate']);
  assert.deepEqual(plan.map(row => row.pair), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  assert.deepEqual(plan.filter((_row, index) => index % 2 === 0).map(row => row.kind), ['AA', 'AA', 'AB', 'AB', 'AB', 'AB', 'AB']);
  assert.equal(protocol('public994').expectedPairs, 7); assert.equal(protocol().expectedPairs, 28);
  assert.notEqual(protocol().completeStatus, protocol('public994').completeStatus);
  for (const selector of ['', '994', 'PUBLIC994', '__proto__', null, {}]) {
    assert.throws(() => schedule(selector), /selector/); assert.throws(() => protocol(selector), /selector/);
  }
});
test('#6537 public994 completion cannot satisfy or weaken the original 56-sample cohort', () => {
  const report = { selector: 'public994', ownedCleanup: { status: 'complete' }, serverCleanup: [{ status: 'complete' }],
    samples: schedule('public994').map(row => ({ ...row, status: 'complete' })),
    pairs: schedule('public994').filter((_row, index) => index % 2 === 0).map(row => ({ family: row.family, index: row.pair, kind: row.kind, status: 'complete' })),
    finalInputVerification: 'complete' };
  requireCohortCompletion(report);
  assert.throws(() => requireCohortCompletion({ ...report, selector: 'public4' }), /cohort/);
  assert.throws(() => requireCohortCompletion({ ...report, selector: 'unknown' }), /selector/);
  assert.throws(() => requireCohortCompletion(report, 'received SIGTERM'), /SIGTERM/);
  for (const change of [value => value.samples.pop(), value => value.pairs.push({ status: 'complete' }),
    value => { value.samples[0].status = 'refused'; }, value => { value.finalInputVerification = 'refused'; },
    value => { value.serverCleanup[0].status = 'refused'; },
    value => { value.samples[0].family = 'house'; }, value => { value.samples[1] = value.samples[0]; },
    value => { [value.samples[4], value.samples[5]] = [value.samples[5], value.samples[4]]; },
    value => { value.samples[0].slot = 1; }, value => { value.pairs[0].family = 'house'; },
    value => { value.pairs[0].index = 1; }, value => { value.pairs[0].kind = 'AB'; },
    value => { [value.pairs[0], value.pairs[1]] = [value.pairs[1], value.pairs[0]]; }]) {
    const changed = structuredClone(report); change(changed); assert.throws(() => requireCohortCompletion(changed), /cohort/);
  }
});
test('#6537 download receipt requires actual canonical source, status, size and hash fields', () => {
  const file = '/owned/public994.ifc';
  const receipt = { status: 'complete-pinned-fixture-download', file, url: public994.url, responseURL: public994.url,
    sourceCommit: public994.sourceCommit, httpStatus: 200, expectedBytes: public994.bytes, bytes: public994.bytes,
    expectedSha256: public994.sha256, sha256: public994.sha256, contentLength: String(public994.bytes),
    requestAcceptEncoding: 'identity', responseContentEncoding: null };
  requirePublic994Receipt(receipt, file);
  requirePublic994Receipt({ ...receipt, responseContentEncoding: 'identity' }, file);
  for (const [key, value] of [['status', 'refused'], ['file', '/foreign/file'], ['url', 'https://example.invalid'],
    ['responseURL', public994.url + '?changed'], ['sourceCommit', 'a'.repeat(40)], ['httpStatus', 302],
    ['expectedBytes', 1], ['bytes', public994.bytes - 1], ['expectedSha256', 'b'.repeat(64)], ['sha256', 'b'.repeat(64)], ['contentLength', '0'],
    ['requestAcceptEncoding', 'gzip'], ['requestAcceptEncoding', undefined], ['responseContentEncoding', 'gzip'], ['responseContentEncoding', undefined]]) {
    assert.throws(() => requirePublic994Receipt({ ...receipt, [key]: value }, file), /receipt/);
  }
});
test('#6537 real HTTP fixture download retains exact bytes and terminal refusal receipts without partial payloads', { timeout: 10000 }, async () => {
  const bytes = Buffer.from('bounded fixture download invariant\n');
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, acceptEncoding: request.headers['accept-encoding'] });
    if (request.url === '/missing') response.writeHead(404);
    else if (request.url === '/redirect') { response.writeHead(302, { location: '/valid' }); response.end(); return; }
    else if (request.url === '/long') { response.end(Buffer.concat([bytes, bytes])); return; }
    else if (request.url === '/short') { response.end(bytes.subarray(1)); return; }
    else if (request.url === '/gzip') {
      const compressed = gzipSync(bytes);
      response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
      response.end(compressed); return;
    }
    else if (request.url === '/identity') response.setHeader('Content-Encoding', 'identity');
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'sdk-public994-download-'));
  const address = server.address(); const origin = `http://127.0.0.1:${address.port}`;
  const pin = { path: 'fixture.ifc', sourceCommit: 'test-only-local-http', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), url: `${origin}/valid` };
  try {
    const receipt = await downloadPinnedFixture(pin, directory);
    assert.equal(receipt.status, 'complete-pinned-fixture-download');
    assert.equal(receipt.requestAcceptEncoding, 'identity'); assert.equal(receipt.responseContentEncoding, null);
    const identity = await downloadPinnedFixture({ ...pin, path: 'identity.ifc', url: `${origin}/identity` }, directory);
    assert.equal(identity.responseContentEncoding, 'identity');
    assert.deepEqual(await readFile(join(directory, 'identity.ifc')), bytes);
    assert.deepEqual(await readFile(join(directory, pin.path)), bytes);
    for (const [index, route] of ['/missing', '/redirect', '/long', '/short', '/wrong-hash', '/gzip'].entries()) {
      const changed = { ...pin, path: `refused-${index}.ifc`, url: `${origin}${route}`,
        sha256: route === '/wrong-hash' ? 'a'.repeat(64) : pin.sha256 };
      await assert.rejects(downloadPinnedFixture(changed, directory));
      const failed = JSON.parse(await readFile(join(directory, `${changed.path}.download.json`), 'utf8'));
      assert.equal(failed.status, 'refused'); assert.equal(failed.url, changed.url); assert.ok(failed.reason);
      assert.equal(failed.requestAcceptEncoding, 'identity');
      if (route === '/gzip') { assert.equal(failed.responseContentEncoding, 'gzip'); assert.match(failed.reason, /content encoding/); }
      assert.ok(!(await readdir(directory)).includes(changed.path));
      assert.ok(!(await readdir(directory)).some(name => name.endsWith('.partial')));
    }
    assert.ok(requests.length >= 8);
    assert.ok(requests.every(request => request.acceptEncoding === 'identity'));
  } finally {
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
