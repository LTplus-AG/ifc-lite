/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A geometry dist older than `rhino-export.js` must skip only the defaults
// contract locally, and must still fail on CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSceneDefaults } from './rhino-export-contract.mjs';

function root(t, withDefaults) {
  const dir = mkdtempSync(join(tmpdir(), 'rhino-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (withDefaults) {
    mkdirSync(join(dir, 'packages/geometry/dist'), { recursive: true });
    writeFileSync(join(dir, 'packages/geometry/dist/rhino-export.js'), 'export const RHINO_SCENE_DEFAULTS = { units: "source" };\n');
  }
  return dir;
}

test('a stale geometry dist skips the defaults contract locally and names the rebuild', async t => {
  const result = await loadSceneDefaults(root(t, false), {});
  assert.match(result.skip, /packages\/geometry\/dist\/rhino-export\.js.*pnpm build/);
});

test('on CI a missing geometry dist is a failure, not a skip', async t => {
  await assert.rejects(loadSceneDefaults(root(t, false), { CI: 'true' }));
});

test('a current geometry dist yields the defaults', async t => {
  assert.deepEqual((await loadSceneDefaults(root(t, true), {})).defaults, { units: 'source' });
});
