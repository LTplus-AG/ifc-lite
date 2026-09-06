/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
const { browserStaticPath } = await tsImport('./perf/browser-cold-server-path.ts', import.meta.url);

test('#3978 static root rejects encoded traversal into a sibling with the same prefix', () => {
  const root = resolve('fixture/dist');
  assert.equal(browserStaticPath(root, '/%2e%2e/dist-backup/private.json'), null);
  assert.equal(browserStaticPath(root, '/%zz'), null);
  assert.equal(browserStaticPath(root, '/'), resolve(root, 'index.html'));
  assert.equal(browserStaticPath(root, '/assets/app.js?q=1'), resolve(root, 'assets/app.js'));
});
for (const [flag, value, expected] of [['--port', '3100', /port must be 3000/], ['--iters', '1.5', /iters must/]]) {
  test(`#3978 rejects ${flag} ${value} before opening a browser/server`, () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/perf/browser-cold-ab.mts', flag, value], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  });
}
