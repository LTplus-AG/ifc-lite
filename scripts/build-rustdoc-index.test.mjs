/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildRustdocIndex } from './build-rustdoc-index.mjs';

test('#4144: Rustdoc deployment gets a real landing page and refuses empty output', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'rustdoc-index-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const docs = join(root, 'target/doc');
  mkdirSync(docs, { recursive: true });
  assert.throws(() => buildRustdocIndex(docs, join(root, 'site/index.html')), /no crate entry points/);
  for (const name of ['ifc_lite_geometry', 'ifc_lite_core']) {
    mkdirSync(join(docs, name)); writeFileSync(join(docs, name, 'index.html'), name);
  }
  assert.deepEqual(buildRustdocIndex(docs, join(root, 'site/index.html')), ['ifc_lite_core', 'ifc_lite_geometry']);
  const html = readFileSync(join(root, 'site/index.html'), 'utf8');
  assert.match(html, /href="\.\/ifc_lite_core\/"/);
  assert.match(html, /ifc-lite-geometry/);
});
