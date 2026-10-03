/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { serveFrozen } from './interleaved-server.mjs';
import { fileHash } from './interleaved-assets.mjs';

test('#6537 frozen server preserves isolation, exact asset bytes and bounded file allowlist', async t => {
  const root = mkdtempSync(join(tmpdir(), 'interleaved-server-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const body = '<html>finite fixture</html>';
  writeFileSync(join(root, 'index.html'), body);
  writeFileSync(join(root, 'unlisted.js'), 'excluded');
  const sha256 = await fileHash(join(root, 'index.html'));
  const server = await serveFrozen(root, [{ path: 'index.html', size: Buffer.byteLength(body), sha256 }]);
  t.after(() => server.close());
  const response = await fetch(server.origin);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${server.origin}/unlisted.js`)).status, 404);
  assert.equal((await fetch(`${server.origin}/index.html`, { method: 'POST' })).status, 404);
  assert.equal(server.requests[0].sha256, sha256);
});

test('#6537 an incomplete owned HTTP request cannot hang terminal server teardown', async t => {
  const root = mkdtempSync(join(tmpdir(), 'interleaved-stalled-server-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = await serveFrozen(root, []);
  const socket = connect(Number(new URL(server.origin).port), '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((resolveConnected, reject) => { socket.once('connect', resolveConnected); socket.once('error', reject); });
  socket.write('GET / HTTP/1.1\r\nHost: incomplete');
  let timer;
  try {
    const receipt = await Promise.race([server.close(30), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Owned server teardown did not bound the open socket')), 1000);
    })]);
    assert.ok(['refused', 'complete'].includes(receipt.status));
    assert.equal(receipt.remainingSockets, 0);
    if (receipt.status === 'refused') { assert.equal(receipt.destroyedSockets, 1); assert.match(receipt.reason, /deadline/); }
  } finally { clearTimeout(timer); }
});
