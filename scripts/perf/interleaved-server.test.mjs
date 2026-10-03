/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
