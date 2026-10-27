/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_SIGNATURES, checkRetainedFree } from './check-viewer-retained-free.mjs';

test('#7955 default-dist guard rejects retained payloads and filenames, including binary assets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retained-free-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(checkRetainedFree(root));
  await writeFile(join(root, 'index.html'), '<html>exact</html>');
  await mkdir(join(root, 'assets'));
  assert.equal(await checkRetainedFree(root), 1);
  // Changelog prose the What's New tab bundles must not trip the guard.
  await writeFile(join(root, 'assets', 'WhatsNew-ABC.js'),
    'Adds `RetainedModelSession.run` to pkg-retained; loadRetainedEngine serves SMLib from `/smlib/`.');
  assert.equal(await checkRetainedFree(root), 2);
  for (const token of CODE_SIGNATURES) {
    await writeFile(join(root, 'assets', 'engine.wasm'), Buffer.concat([Buffer.from([0, 1]), Buffer.from(token)]));
    await assert.rejects(checkRetainedFree(root), /Default dist contains/);
  }
  await rm(join(root, 'assets', 'engine.wasm'));
  await writeFile(join(root, 'assets', 'retained-ABC.js'), 'no identifying content');
  await assert.rejects(checkRetainedFree(root), /Retained asset/);
});
